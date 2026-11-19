#!/usr/bin/env node
// 禅道只读查询器（rh-product-feedback 随包脚本）。
//
// 为什么有它：get_products / get_projects / get_products_productID_bugs 的原始响应是
// 几十 KB 到上百 KB 的 JSON（每个产品对象带 70 多个统计字段，单个 1.3KB），直接进
// Agent 上下文会被截断；Agent 只能反复调小 recPerPage 试错，既慢又拿不全（实测一次
// 提 bug 的耗时里，有 8 分钟耗在这上面）。这个脚本把「取数据 + 过滤 + 投影」全部放在
// 进程内做完，只把十几行表格打印出来，原始 JSON 不进上下文。
//
// 边界：
//   - 只读。建单、更新、流转走随包的写入脚本 zentao-write.mjs（保留用户确认链路）。
//   - 凭据由脚本自己从本机凭据文件读并换用户令牌，密码与令牌不打印、不进 Agent 上下文。
//   - 请求带用户令牌，读到的范围是当前账号可见的范围（不是服务端固定账号的）。
//   - 不回显禅道地址；地址一致性检查只给结论。
//
// 用法：node zentao-query.mjs <命令> [选项]，详见 --help。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectAsUser, loadPackageConfig } from './zentao-client.mjs';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3; // 与技能里的查重范围一致：最多 3 页、300 条
const DEFAULT_LIMIT = 10;
const MATCH_THRESHOLD = 0.5;

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const cmd = first && !first.startsWith('--') ? first : '';
  const opts = {};
  const positional = [];
  const args = cmd ? rest : [first, ...rest];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { cmd, opts, positional };
}
// ---------------------------------------------------------------- 连接

// 连上禅道：换当前用户的令牌，再带令牌建 MCP 会话。
// 令牌在进程内使用；读到的产品、项目、单据都是当前账号可见的，不是服务端固定账号的。
async function connect() {
  const { client, cfg } = await connectAsUser();
  return Object.assign(client, { cfg });
}

// ---------------------------------------------------------------- 列表与过滤

const LIST_KEYS = ['products', 'projects', 'bugs', 'feedbacks', 'users'];

function pickList(body) {
  for (const key of LIST_KEYS) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  for (const value of Object.values(body || {})) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

// 分页拉全量：禅道的 recPerPage / pageID 必须是字符串（传数字服务端报 -32602）
async function fetchList(ctx, tool, args, maxPages = DEFAULT_MAX_PAGES, pageSize = DEFAULT_PAGE_SIZE) {
  const items = [];
  let pager = null;
  for (let page = 1; page <= maxPages; page++) {
    const { body } = await ctx.call(tool, { ...args, pageID: String(page), recPerPage: String(pageSize) });
    const pageItems = pickList(body);
    items.push(...pageItems);
    if (body?.pager) pager = body.pager;
    const total = Number(pager?.recTotal ?? pageItems.length);
    if (pageItems.length === 0 || items.length >= total) break;
  }
  return { items, pager, total: Number(pager?.recTotal ?? items.length) };
}

// 关键词特征：中文取二元组，英文按词——中文标题语序常与用户口语不同，二元组重叠更稳
function features(text) {
  const set = new Set();
  const norm = String(text || '').toLowerCase();
  const chunks = norm.split(/[\s,，。、；;：:!！?？/\\()（）\[\]{}"'`~·—–_\-]+/u).filter(Boolean);
  for (const chunk of chunks) {
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      if (chunk.length === 1) set.add(chunk);
      for (let i = 0; i + 1 < chunk.length; i++) set.add(chunk.slice(i, i + 2));
    } else {
      set.add(chunk);
    }
  }
  return set;
}

// 查询词被标题覆盖的比例（0~1）
function matchScore(query, title) {
  const q = String(query || '').trim();
  const t = String(title || '').toLowerCase();
  if (!q) return 1;
  const normQ = q.toLowerCase().replace(/\s+/g, '');
  const normT = t.replace(/\s+/g, '');
  if (normT.includes(normQ)) return 1;
  const a = features(q);
  const b = features(t);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const feature of a) if (b.has(feature)) inter++;
  if (inter < 2 && a.size > 1) return 0;
  return inter / a.size;
}

// 关键词匹配：relative=true 时只留与最佳结果得分接近的（选品用，避免带出弱相关项）
function rankByMatch(query, items, pickTitle, limit, { relative = false } = {}) {
  if (!query) return items.slice(0, limit);
  const scored = items
    .map((item) => ({ item, score: matchScore(query, pickTitle(item)) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  const kept = relative ? scored.filter((entry) => entry.score >= best * 0.85) : scored;
  return kept.slice(0, limit).map((entry) => entry.item);
}

// 选品：先看名字完全一致，再看匹配分是否明显领先；都不成立就交给人挑
function resolveProduct(wanted, products) {
  const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, '');
  const exact = products.find((p) => norm(p.name) === norm(wanted));
  if (exact) return { product: exact };
  const scored = products
    .map((p) => ({ product: p, score: matchScore(wanted, `${p.name} ${p.code || ''}`) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { none: true };
  const top = scored[0];
  const second = scored[1];
  if (top.score >= 0.6 && (!second || top.score - second.score >= 0.15)) return { product: top.product };
  return { candidates: scored.map((entry) => entry.product) };
}

// ---------------------------------------------------------------- 输出

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function cell(value) {
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value).replace(/\s+/g, ' ').trim();
}

function assignee(value) {
  return value === undefined || value === null || value === '' ? '（未指派）' : cell(value);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== ''))
    .join('\n')
    .trim();
}

function printTable(header, rows) {
  out(`# ${header}`);
  for (const row of rows) out(row.join('\t'));
}

// ---------------------------------------------------------------- 命令

async function cmdProducts(ctx, opts) {
  const { items, total } = await fetchList(ctx, 'get_products', {}, 3);
  const match = opts.match ? String(opts.match) : '';
  const limit = Number(opts.limit) || items.length;
  const matched = match ? rankByMatch(match, items, (p) => `${p.name} ${p.code || ''}`, items.length, { relative: true }) : items;
  if (match && matched.length === 0) {
    out(`# 没有匹配「${match}」的产品（当前账号可见 ${total} 个，下面列出全部）`);
    for (const p of items) out([cell(p.id), cell(p.name), cell(p.code)].join('\t'));
    return;
  }
  printTable(`产品（可见 ${total} 个${match ? `，匹配「${match}」` : ''}）`, matched.slice(0, limit).map((p) => [
    cell(p.id),
    cell(p.name),
    cell(p.code),
    cell(p.status),
  ]));
}

async function cmdProjects(ctx, opts) {
  const { items, total } = await fetchList(ctx, 'get_projects', {}, 3);
  const doing = items.filter((p) => p.status === 'doing');
  const match = opts.match ? String(opts.match) : '';
  const limit = Number(opts.limit) || items.length;
  const matched = match ? rankByMatch(match, items, (p) => p.name, items.length) : items;
  printTable(
    `项目（可见 ${total} 个，其中 doing ${doing.length} 个${match ? `，匹配「${match}」` : ''}）`,
    matched.slice(0, limit).map((p) => [cell(p.id), cell(p.name), cell(p.status)].join('\t'))
  );
}

async function cmdBugs(ctx, opts) {
  const productId = opts.product;
  if (!productId) throw new Error('用法：zentao-query.mjs bugs --product <产品ID> [--match 关键词]');
  const { items, total } = await fetchList(ctx, 'get_products_productID_bugs', { productID: String(productId) });
  const match = opts.match ? String(opts.match) : '';
  const limit = Number(opts.limit) || DEFAULT_LIMIT;
  const matched = match ? rankByMatch(match, items, (b) => b.title, limit) : items.slice(0, limit);
  out(`# 缺陷（产品 ${productId} 可见 ${total} 条，已扫 ${items.length} 条，匹配 ${matched.length} 条）`);
  for (const bug of matched) {
    out([cell(bug.id), cell(bug.title), cell(bug.status), assignee(bug.assignedTo)].join('\t'));
  }
}

async function cmdFeedbacks(ctx, opts) {
  const productId = opts.product;
  if (!productId) throw new Error('用法：zentao-query.mjs feedbacks --product <产品ID> [--match 关键词]');
  const { items, total } = await fetchList(ctx, 'get_products_productID_feedbacks', { productID: String(productId) });
  const match = opts.match ? String(opts.match) : '';
  const limit = Number(opts.limit) || DEFAULT_LIMIT;
  const matched = match ? rankByMatch(match, items, (f) => f.title, limit) : items.slice(0, limit);
  out(`# 反馈（产品 ${productId} 可见 ${total} 条，已扫 ${items.length} 条，匹配 ${matched.length} 条）`);
  for (const feedback of matched) {
    out([cell(feedback.id), cell(feedback.title), cell(feedback.status), assignee(feedback.assignedTo)].join('\t'));
  }
}

async function cmdBug(ctx, opts) {
  const id = opts.id;
  if (!id) throw new Error('用法：zentao-query.mjs bug --id <缺陷ID> [--no-body]');
  const { body } = await ctx.call('get_bugs_bugID', { bugID: String(id) });
  const bug = body?.bug || {};
  const actions = body?.actions || bug.actions || [];
  out(`# 缺陷 ${cell(bug.id)}`);
  out(['产品', cell(bug.product)].join('\t'));
  out(['标题', cell(bug.title)].join('\t'));
  out(['状态', cell(bug.status)].join('\t'));
  out(['严重程度', cell(bug.severity)].join('\t'));
  out(['优先级', cell(bug.pri)].join('\t'));
  out(['类型', cell(bug.type)].join('\t'));
  out(['影响版本', cell(bug.openedBuild)].join('\t'));
  out(['所属项目', cell(bug.project)].join('\t'));
  out(['负责人', assignee(bug.assignedTo)].join('\t'));
  out(['提交人', cell(bug.openedBy)].join('\t'));
  if (!opts['no-body']) {
    out('正文');
    out(stripHtml(bug.steps) || '（空）');
  }
  out('流水');
  for (const action of actions) {
    out([cell(action.action), cell(action.actor), cell(action.date), cell(action.comment)].join('\t'));
  }
}

async function cmdFeedback(ctx, opts) {
  const id = opts.id;
  if (!id) throw new Error('用法：zentao-query.mjs feedback --id <反馈ID> [--no-body]');
  const { body } = await ctx.call('get_feedbacks_feedbackID', { feedbackID: String(id) });
  const feedback = body?.feedback || {};
  const actions = body?.actions || feedback.actions || [];
  out(`# 反馈 ${cell(feedback.id)}`);
  out(['产品', cell(feedback.product)].join('\t'));
  out(['标题', cell(feedback.title)].join('\t'));
  out(['状态', cell(feedback.status)].join('\t'));
  out(['类型', cell(feedback.type)].join('\t'));
  out(['负责人', assignee(feedback.assignedTo)].join('\t'));
  out(['提交人', cell(feedback.feedbackBy)].join('\t'));
  if (!opts['no-body']) {
    out('正文');
    out(stripHtml(feedback.desc) || '（空）');
  }
  out('流水');
  for (const action of actions) {
    out([cell(action.action), cell(action.actor), cell(action.date), cell(action.comment)].join('\t'));
  }
}

// 一次拿到「产品 + 项目 + 缺陷/反馈候选」，替掉 Agent 串行的四轮查询
async function cmdPrep(ctx, opts) {
  const wanted = opts.product ? String(opts.product) : '';
  const match = opts.match ? String(opts.match) : '';
  if (!wanted) throw new Error('用法：zentao-query.mjs prep --product <产品名或ID> [--match 关键词]');

  const { items: products, total: productTotal } = await fetchList(ctx, 'get_products', {}, 3);
  let product = null;
  if (/^\d+$/.test(wanted)) {
    product = products.find((p) => String(p.id) === wanted) || null;
  } else {
    const resolved = resolveProduct(wanted, products);
    if (resolved.product) product = resolved.product;
    else if (resolved.candidates) {
      out(`# 「${wanted}」匹配到多个产品，选一个再用 --product <ID>：`);
      for (const p of resolved.candidates) out([cell(p.id), cell(p.name)].join('\t'));
      return;
    }
  }
  if (!product) {
    out(`# 没找到产品「${wanted}」（当前账号可见 ${productTotal} 个，下面列出全部）`);
    for (const p of products) out([cell(p.id), cell(p.name)].join('\t'));
    return;
  }

  out(`# 产品 ${cell(product.id)} ${cell(product.name)}`);
  out(`# 可见产品共 ${productTotal} 个`);

  const { items: projects } = await fetchList(ctx, 'get_projects', {}, 3);
  const doing = projects.filter((p) => p.status === 'doing');
  const sameName = projects.filter((p) => p.name === product.name);
  out(`# 项目（可见 ${projects.length} 个，doing ${doing.length} 个，与产品同名 ${sameName.length} 个）`);
  const ordered = [...sameName, ...projects.filter((p) => p.name !== product.name)];
  for (const project of ordered) {
    const tag = project.name === product.name ? '与产品同名' : '';
    out([cell(project.id), cell(project.name), cell(project.status), tag].filter(Boolean).join('\t'));
  }

  const { items: bugs, total: bugTotal } = await fetchList(ctx, 'get_products_productID_bugs', { productID: String(product.id) });
  const bugHits = match ? rankByMatch(match, bugs, (b) => b.title, DEFAULT_LIMIT) : [];
  out(`# 缺陷（可见 ${bugTotal} 条，已扫 ${bugs.length} 条${match ? `，匹配「${match}」${bugHits.length} 条` : ''}）`);
  for (const bug of bugHits) out([cell(bug.id), cell(bug.title), cell(bug.status), assignee(bug.assignedTo)].join('\t'));

  const { items: feedbacks, total: feedbackTotal } = await fetchList(ctx, 'get_products_productID_feedbacks', { productID: String(product.id) });
  const feedbackHits = match ? rankByMatch(match, feedbacks, (f) => f.title, DEFAULT_LIMIT) : [];
  out(`# 反馈（可见 ${feedbackTotal} 条，已扫 ${feedbacks.length} 条${match ? `，匹配「${match}」${feedbackHits.length} 条` : ''}）`);
  for (const feedback of feedbackHits) out([cell(feedback.id), cell(feedback.title), cell(feedback.status), assignee(feedback.assignedTo)].join('\t'));
}

// 产品的默认承接人：缺省建单时会被指派给谁（产品 QD），以及这个账号还能不能用
async function cmdQd(ctx, opts) {
  const wanted = opts.product ? String(opts.product) : '';
  if (!wanted) throw new Error('用法：zentao-query.mjs qd --product <产品名或ID>');

  const { items: products, total } = await fetchList(ctx, 'get_products', {}, 3);
  let product = null;
  if (/^\d+$/.test(wanted)) {
    product = products.find((p) => String(p.id) === wanted) || null;
  } else {
    const resolved = resolveProduct(wanted, products);
    if (resolved.product) product = resolved.product;
    else if (resolved.candidates) {
      out(`# 「${wanted}」匹配到多个产品，选一个再用 --product <ID>：`);
      for (const p of resolved.candidates) out([cell(p.id), cell(p.name)].join('\t'));
      return;
    }
  }
  if (!product) {
    out(`# 没找到产品「${wanted}」（当前账号可见 ${total} 个，下面列出全部）`);
    for (const p of products) out([cell(p.id), cell(p.name)].join('\t'));
    return;
  }

  const { body } = await ctx.call('get_products_productID', { productID: String(product.id) });
  const detail = body?.product || {};
  const qd = String(detail.QD || '').trim();
  out(`# 产品 ${cell(product.id)} ${cell(product.name)} 的默认承接人`);
  if (!qd) {
    out(['QD账号', '（空）'].join('\t'));
    out(['说明', '该产品没配 QD，缺省建单不指派任何人'].join('\t'));
    return;
  }
  out(['QD账号', qd].join('\t'));

  const { items: users } = await fetchList(ctx, 'get_users', {}, 3);
  const user = users.find((u) => u.account === qd);
  if (!user) {
    out(['姓名', '（禅道用户表里没有这个账号）'].join('\t'));
    out(['账号状态', '查不到——可能已从禅道删除'].join('\t'));
    return;
  }
  out(['姓名', cell(user.realname)].join('\t'));
  if (String(user.deleted) === '1') out(['账号状态', '已删除（deleted=1）'].join('\t'));
  else if (String(user.locked || '') !== '') out(['账号状态', '已锁定'].join('\t'));
  else out(['账号状态', '可用'].join('\t'));
  out(['最后登录', cell(user.last)].join('\t'));
}

// ---------------------------------------------------------------- 宿主地址一致性

// 宿主 MCP 配置位置。默认覆盖 Claude Code 与 pi；Agent 可以用 --config/--pointer 指向当前宿主。
function hostConfigPaths(opts = {}) {
  const pointer = String(opts.pointer || 'mcpServers.zentao');
  if (typeof opts.config === 'string' && opts.config.trim()) {
    return [{ host: String(opts.host || '当前宿主'), file: path.resolve(opts.config.trim()), pointer }];
  }
  const home = os.homedir();
  const paths = [];
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    paths.push({ host: 'pi', file: path.join(base, 'pi', 'agent', 'mcp.json'), pointer });
  } else {
    paths.push({ host: 'Claude Code', file: path.join(home, '.claude.json'), pointer });
    paths.push({ host: 'pi', file: path.join(home, '.pi', 'agent', 'mcp.json'), pointer });
  }
  return paths;
}

// 指针形如 mcpServers.zentao：逐段下钻
function getAtPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAtPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function readHostEntry(file, pointer) {
  if (!fs.existsSync(file)) return { exists: false, entry: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = getAtPath(data, String(pointer || 'mcpServers.zentao').split('.').filter(Boolean)) || null;
    return { exists: true, entry };
  } catch {
    return { exists: true, entry: null, broken: true };
  }
}

// 只给结论，不回显地址
function cmdCheck(opts = {}) {
  const pkgUrl = loadPackageConfig().mcpUrl || '';
  const lines = [];
  let found = 0;
  for (const { host, file, pointer } of hostConfigPaths(opts)) {
    const { exists, entry } = readHostEntry(file, pointer);
    if (!exists) {
      lines.push(`${host}：没有配置文件`);
      continue;
    }
    if (!entry) {
      lines.push(`${host}：没有 zentao 条目`);
      continue;
    }
    found++;
    const url = entry.url || '';
    lines.push(url === pkgUrl ? `${host}：地址与技能包一致` : `${host}：地址与技能包不一致`);
  }
  out('# 宿主 MCP 地址检查');
  for (const line of lines) out(line);
  if (!found) out('结论：宿主里没有 zentao 条目，按 setup.md 的「各宿主配置」登记禅道 MCP。');
  else if (lines.some((l) => l.includes('不一致'))) out('结论：有不一致，跑 `zentao-query.mjs sync` 修正（只改 zentao 条目的 url，写前备份）。');
  else out('结论：一致，不用改。');
}

// 只改 zentao 条目的 url，保留其他字段；写前备份
function cmdSync(opts = {}) {
  const pkgUrl = loadPackageConfig().mcpUrl || '';
  if (!pkgUrl) throw new Error('技能包里没有配置禅道 MCP 地址');
  out('# 同步宿主 MCP 地址');
  let changed = 0;
  for (const { host, file, pointer } of hostConfigPaths(opts)) {
    const { exists, entry, broken } = readHostEntry(file, pointer);
    if (!exists) {
      out(`${host}：没有配置文件，跳过`);
      continue;
    }
    if (broken) {
      out(`${host}：配置文件不是合法 JSON，跳过`);
      continue;
    }
    if (!entry) {
      out(`${host}：没有 zentao 条目，跳过（按 setup.md 的「各宿主配置」登记）`);
      continue;
    }
    if (entry.url === pkgUrl) {
      out(`${host}：已一致，不用改`);
      continue;
    }
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    setAtPath(data, String(pointer).split('.').filter(Boolean), { ...entry, url: pkgUrl });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    changed++;
    out(`${host}：已更新 zentao 条目的 url（备份：${path.basename(backup)}）`);
  }
  if (!changed) out('结论：没有需要改的地址。');
  else out('结论：已更新，重开宿主生效。');
}

// ---------------------------------------------------------------- 入口

const HELP = `禅道只读查询器（rh-product-feedback）

  products  [--match 关键词]           列出当前账号可见的产品
  projects  [--match 关键词]           列出可见项目
  bugs      --product <ID> [--match 关键词]     产品下的缺陷（查重候选）
  feedbacks --product <ID> [--match 关键词]     产品下的反馈单（查重候选）
  bug       --id <ID>                  缺陷详情（字段 + 正文 + 流水）
  feedback  --id <ID>                  反馈单详情（字段 + 正文 + 流水）
  prep      --product <名称或ID> [--match 关键词]   产品 + 项目 + 查重候选，一次拿全
  qd        --product <名称或ID>         产品的默认承接人（QD 账号 + 账号是否还能用）
  check     [--config <文件> [--pointer <路径>]]   宿主 MCP 地址与技能包是否一致（只给结论）
  sync      [--config <文件> [--pointer <路径>]]   把宿主里的 zentao 地址改成技能包的（只改 url）

选项：--match 关键词（查重/选品用，中英文都支持）  --limit 条数  --no-body（详情里不打印正文）
check/sync 选项：--config 宿主 MCP 配置文件（不给则查内置的 Claude Code 与 pi 两处）
                 --pointer 条目在文件里的位置（默认 mcpServers.zentao）  --host 宿主名（只影响输出）
环境变量：ZENTAO_MCP_URL 覆盖禅道 MCP 地址  ZENTAO_WEB_URL 覆盖禅道 Web 地址（换令牌用）
          ZENTAO_CREDENTIALS_FILE 覆盖本机凭据文件路径
认证：脚本用本机凭据直连禅道换当前用户的令牌，再带令牌读——可见范围是当前账号的。`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || opts.help) {
    out(HELP);
    return;
  }
  if (cmd === 'check') return cmdCheck(opts);
  if (cmd === 'sync') return cmdSync(opts);

  const ctx = await connect();
  switch (cmd) {
    case 'products': return cmdProducts(ctx, opts);
    case 'projects': return cmdProjects(ctx, opts);
    case 'bugs': return cmdBugs(ctx, opts);
    case 'feedbacks': return cmdFeedbacks(ctx, opts);
    case 'bug': return cmdBug(ctx, opts);
    case 'feedback': return cmdFeedback(ctx, opts);
    case 'prep': return cmdPrep(ctx, opts);
    case 'qd': return cmdQd(ctx, opts);
    default:
      out(HELP);
      throw new Error(`未知命令：${cmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`错误：${err?.message || err}\n`);
  process.exit(1);
});
