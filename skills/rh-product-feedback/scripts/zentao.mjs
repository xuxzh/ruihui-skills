#!/usr/bin/env node
// 禅道入口脚本（rh-product-feedback 随包脚本）：换令牌 → 注入官方禅道 CLI → 取数 → 投影。
//
// 为什么有它：禅道 CLI 的原始响应是几十 KB 的 JSON（每个产品对象带几十个统计字段），
// 直接进 Agent 上下文会被截断，Agent 只能反复翻页试错。这个脚本把「换令牌 + 取数 +
// 投影」全部放在进程内做完，只把十几行紧凑表格打印出来，原始 JSON 不进上下文。
//
// 边界：
//   - 认证：读本机凭据文件换一个属于当前用户的当次令牌（密码换令牌，或直接用个人令牌）。
//     令牌只在脚本进程内，经环境变量 ZENTAO_TOKEN 注入 CLI 子进程——不进命令行参数、
//     不打印、不落盘、不进 Agent 上下文。
//   - 取值范围：请求带用户令牌，读到的是当前账号可见的范围，不是服务端固定账号的。
//   - 禅道站点地址只从 config.local.json（或环境变量）读，不主动回显。
//
// 用法：node zentao.mjs <子命令> [选项]，详见 --help。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
// 查重助手：切词与变体生成在这里，取数与匹配在入口脚本里做
import { matchScore, rankByMatch, variantGroups } from './zentao-dedupe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(PKG_DIR, 'config.local.json');

// 官方禅道 CLI 的命令名（npm 包 zentao-cli 装出来的可执行文件）
const CLI_BIN = 'zentao';
// --assistant 的值会进 HTTP 头，不能含中文或换行
const ASSISTANT = 'AI rh-product-feedback';
const CLI_TIMEOUT_MS = 180000;

// ===== 公共：换令牌 / 注入 CLI / 调用 / 投影 =====

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

// 用法错误用独立类型区分：退出码 2（与禅道 CLI 的约定一致）
class UsageError extends Error {}

function usage(text) {
  return new UsageError(`用法：${text}`);
}

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const cmd = first && !first.startsWith('--') ? first : '';
  const args = cmd ? rest : argv;
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || !arg.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[arg.slice(2)] = next;
      i++;
    } else {
      opts[arg.slice(2)] = true;
    }
  }
  return { cmd, opts };
}

// ---------------------------------------------------------------- 本机配置与凭据

/** 技能包配置（站点地址在这里，不回显）。 */
function loadPackageConfig(env) {
  const file = env.ZENTAO_PACKAGE_CONFIG_FILE || CONFIG_PATH;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`读不到技能包配置：${path.basename(file)}`);
  }
}

/** 本机接入凭据文件路径。 */
function credentialsPath(env) {
  if (env.ZENTAO_CREDENTIALS_FILE) return env.ZENTAO_CREDENTIALS_FILE;
  const base = process.platform === 'win32'
    ? (env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), '.config');
  return path.join(base, 'rh-zentao', 'credentials');
}

/** 读本机凭据；没有文件时返回空对象（调用方给可执行指引，不要索要密码）。 */
function loadCredentials(env) {
  const file = credentialsPath(env);
  if (!fs.existsSync(file)) return {};
  const creds = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) creds[key] = value;
  }
  return creds;
}

/** 禅道站点地址：环境变量优先，其次技能包 config.local.json。 */
function resolveSite(cfg, env) {
  return String(env.ZENTAO_WEB_URL || cfg?.zentaoWebUrl || '').replace(/\/+$/, '');
}

/**
 * 换当前用户的禅道令牌。返回 { account, token }。
 * 失败时抛错，错误信息要能指导下一步，但不回显账号、密码、令牌。
 */
async function resolveUserToken(creds, site) {
  const account = String(creds.ZENTAO_ACCOUNT || '').trim();
  const personalToken = String(creds.ZENTAO_TOKEN || '').trim();
  const password = String(creds.ZENTAO_PASSWORD || '').trim();

  // 禅道界面「个人 → 令牌」生成的令牌本身就是用户身份，直接用。
  if (personalToken) return { account, token: personalToken };

  if (!account || !password) {
    throw new Error(
      '本机没有禅道接入凭据。在你自己的终端跑一次 `bash <技能目录>/scripts/set-credentials.sh`' +
        '（Windows 用 set-credentials.ps1）写入账号与密码；不要在对话里把密码告诉 Agent。'
    );
  }
  if (!site) {
    throw new Error('技能包里没有配置禅道站点地址（config.local.json 的 zentaoWebUrl），换不到当次令牌。');
  }

  let res;
  try {
    res = await fetch(`${site}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
  } catch (err) {
    throw new Error(`连不上禅道（换令牌失败）：${err?.message || err}`);
  }

  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.token) return { account, token: String(body.token) };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error(
      '禅道拒绝了本机凭据（账号或密码不对，或账号被锁定）。请在你的终端重写接入凭据后重试；' +
        '连续失败可能触发禅道锁号，不要反复试。'
    );
  }
  throw new Error(`换禅道令牌失败（HTTP ${res.status}）。`);
}

// ---------------------------------------------------------------- 调用禅道 CLI

// 注入点：令牌只在这里经环境变量交给 CLI 子进程，命令行参数里没有它。
async function connect(env) {
  const cfg = loadPackageConfig(env);
  const site = resolveSite(cfg, env);
  const { account, token } = await resolveUserToken(loadCredentials(env), site);
  return { ...env, ZENTAO_URL: site, ZENTAO_ACCOUNT: account, ZENTAO_TOKEN: token };
}

function cliArgs(...args) {
  // --no-input：不弹浏览器、不提问；--format=json：让 CLI 给出 {ok,data,meta} 封装
  return ['--format=json', '--no-input', '--assistant', ASSISTANT, ...args];
}

// CLI 的失败都带 {ok:false,error:{code,message}}；detail 里有站点地址，不回显
// 官方错误码挂到 err.cliCode 上：调用方要按码分辨错误类型，不能靠在中文信息里抠字
function cliFailure(stderr) {
  try {
    const body = JSON.parse(String(stderr || ''));
    const code = body?.error?.code ? `（${body.error.code}）` : '';
    if (body?.error?.message) {
      const error = new Error(`禅道 CLI 报错${code}：${body.error.message}`);
      error.cliCode = body?.error?.code ? String(body.error.code) : '';
      return error;
    }
  } catch {
    // stderr 不是 JSON，落到下面兜底
  }
  const text = String(stderr || '').trim().split('\n')[0];
  return new Error(text ? `禅道 CLI 执行失败：${text}` : '禅道 CLI 执行失败');
}

/** 跑一次禅道 CLI，返回解析后的 { ok, data, meta }。 */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    execFile(CLI_BIN, cliArgs(...args), { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error('找不到 zentao 命令：禅道 CLI 没装，或不在 PATH 里（npm 包 zentao-cli）。'));
        return;
      }
      if (err && (err.killed || err.signal)) {
        reject(new Error('禅道 CLI 执行超时。先查一下这次请求是不是已经生效，不要直接重试。'));
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(String(stdout || ''));
      } catch {
        payload = null;
      }
      if (payload && payload.ok === true) {
        resolve(payload);
        return;
      }
      if (payload && payload.ok === false) {
        reject(cliFailure(JSON.stringify(payload)));
        return;
      }
      if (err) {
        reject(cliFailure(stderr));
        return;
      }
      reject(new Error('禅道 CLI 的响应看不懂：既不是成功封装，也不是错误封装。'));
    });
  });
}

// ---------------------------------------------------------------- 投影

function cell(value) {
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value).replace(/\s+/g, ' ').trim();
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

// 项目上的产品字段可能是整数，也可能是 {id,name} 对象
function idOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value.id ?? '');
  return String(value);
}

// ===== 读子命令 =====

// 当前账号可见的产品：这就是后续选品范围
async function cmdProducts(env) {
  const { data } = await runCli(['product', 'list', '--all', '--fields', 'id,name'], env);
  const products = rowsOf(data);
  out(`# 产品（当前账号可见 ${products.length} 个；这就是后续选品范围）`);
  for (const product of products) out([cell(product.id), cell(product.name)].join('\t'));
}

// 可见项目；给了 --product 就只看这个产品下面的
async function cmdProjects(env, opts) {
  const wanted = String(opts.product ?? '').trim();
  if (wanted && !/^\d+$/.test(wanted)) throw usage('node zentao.mjs projects [--product <产品ID>]（产品 ID 是数字）');
  const { data } = await runCli(['project', 'list', '--all', '--fields', 'id,name,product,status'], env);
  const all = rowsOf(data);
  const projects = wanted ? all.filter((project) => idOf(project.product) === wanted) : all;
  const doing = projects.filter((project) => String(project.status) === 'doing').length;
  out(`# 项目（${wanted ? `产品 ${wanted} 下 ` : '可见 '}${projects.length} 个，其中进行中 ${doing} 个）`);
  for (const project of projects) out([cell(project.id), cell(project.name), cell(project.status)].join('\t'));
}

// ---------------------------------------------------------------- 单据（列表与详情）

// 列表默认只打十行：再多的单据一次倒进上下文也是白搭，要更多让他显式加 --limit
const DEFAULT_LIST_LIMIT = 10;

// 缺陷列表投影：够判断「到哪了」的字段，正文不进表格。
// product 不进表格，但要参与归属校验（请求的是产品 X，回来的记录 product 字段不是 X 就不能算）
const BUG_LIST_FIELDS = 'id,title,status,assignedTo,severity,pri,product';
const FEEDBACK_LIST_FIELDS = 'id,title,status,assignedTo,product';
// 详情投影：正文 + 状态 + 负责人 + 处理人/处理时间/结论 + 流水
const BUG_DETAIL_FIELDS =
  'id,title,status,product,type,severity,pri,openedBuild,openedBy,openedDate,assignedTo,resolvedBy,resolvedDate,resolution,steps,actions';
const FEEDBACK_DETAIL_FIELDS =
  'id,title,status,product,type,openedBy,openedDate,assignedTo,reviewedBy,reviewedDate,processedBy,processedDate,solution,desc,actions';

// 负责人为空时写「未指派」：那是「没人接」，不是「字段缺失」
function assignee(value) {
  return value === undefined || value === null || value === '' ? '（未指派）' : cell(value);
}

// 正文剥标签：缺陷单的 steps 是结构化 HTML，归一化后要与草稿正文逐字可比
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

function productIdOf(opts, cmd) {
  const wanted = String(opts.product ?? '').trim();
  if (!wanted) throw usage(`node zentao.mjs ${cmd} --product <产品ID>`);
  if (!/^\d+$/.test(wanted)) throw usage(`node zentao.mjs ${cmd} --product <产品ID>（产品 ID 是数字）`);
  return wanted;
}

function recordIdOf(opts, cmd) {
  const wanted = String(opts.id ?? '').trim();
  if (!wanted) throw usage(`node zentao.mjs ${cmd} --id <单据ID>`);
  if (!/^\d+$/.test(wanted)) throw usage(`node zentao.mjs ${cmd} --id <单据ID>（单据 ID 是数字）`);
  return wanted;
}

function listLimitOf(opts) {
  const raw = opts.limit;
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const limit = Number(raw);
  if (raw === true || !Number.isInteger(limit) || limit <= 0) throw usage('--limit 要给正整数');
  return limit;
}

// 客户端筛选：先用 --filter 按状态，再用 --search 只在标题里找关键词
function listFilterArgs(opts) {
  const args = [];
  const status = String(opts.status ?? '').trim();
  if (status) args.push('--filter', `status=${status}`);
  const match = String(opts.match ?? '').trim();
  if (match) args.push('--search', match, '--search-fields', 'title');
  return args;
}

/**
 * 服务端分页不前进：--all 遍历时会整条失败（E2008）。这条保护同时覆盖两种情况——
 * 请求的页码与服务端回的页码不一致、以及相邻两页内容完全相同。
 * 实测：某台 max 8.2 实例的产品反馈列表从第 2 页起返回空集并把 pageID 钳回 1。
 */
function isPagingStuck(err) {
  return String(err?.cliCode || '') === '2008' && /分页未向前推进/.test(String(err?.message || ''));
}

/**
 * 读一个列表命令的全量：--all 翻完所有页，返回
 * { rows, scanned, total, foreign, complete, reason }。
 * 服务端分页不前进时不整条失败，退回只读第 1 页；拿到的记录照常用，但这次扫描算不完整——
 * 第 1 页不是全部，不能当成全部说出去。
 *
 * 回退取回的记录还要做归属校验：请求的是产品 X，回来的记录 product 字段不是 X，就不是这个产品的记录。
 * 实测某台 max 8.2 实例上请求产品 29 的反馈列表会返回 product=1 的记录，照用会把别的产品的数据
 * 当成这个产品的（查重基线、覆盖范围全跟着错），所以这类记录一律丢弃并在输出里点名。
 */
async function runListScan(args, productId, env) {
  const scanOf = (payload, complete, reason) => {
    const fetched = rowsOf(payload.data);
    const rows = [];
    const dropped = [];
    for (const row of fetched) (isProductRecord(row, productId) ? rows : dropped).push(row);
    const total = Number(payload.meta?.total ?? fetched.length);
    return {
      rows,
      // 扫到 = 服务端给了多少条，减掉不属于这个产品的
      scanned: Number(payload.meta?.fetched ?? fetched.length) - dropped.length,
      total,
      foreign: { count: dropped.length, products: [...new Set(dropped.map((row) => idOf(row.product)))] },
      complete,
      reason,
    };
  };
  try {
    return scanOf(await runCli([...args, '--all'], env), true, '');
  } catch (err) {
    if (!isPagingStuck(err)) throw err;
    const first = await runCli([...args, '--page', '1'], env);
    return scanOf(first, false, '服务端分页未向前推进');
  }
}

// 记录没带 product 字段时判不了归属（投影里没取到），只能照用；带了就必须与请求的产品一致
function isProductRecord(row, productId) {
  const product = row?.product;
  if (product === undefined || product === null || product === '') return true;
  return idOf(product) === String(productId);
}

// 覆盖范围的一句话：扫了多少条、扫全没有、有没有丢掉不属于这个产品的记录。
function scanCoverage(scan, productId) {
  const parts = [];
  if (scan.complete && !scan.foreign.count) {
    parts.push(`可见 ${scan.total} 条，已扫 ${scan.scanned} 条`);
  } else {
    parts.push(`扫到 ${scan.scanned} 条`);
    if (scan.total > scan.scanned + scan.foreign.count) parts.push(`服务端称共有 ${scan.total} 条`);
    if (!scan.complete) parts.push(scan.reason);
  }
  if (scan.foreign.count) {
    parts.push(
      `禅道返回的 ${scan.foreign.count} 条记录 product 字段是 ${scan.foreign.products.join('/')}，不属于产品 ${productId}，已丢弃`
    );
  }
  if (!scan.complete) parts.push('覆盖不完整');
  return parts.join('，');
}

// 表头说清范围：「产品 101 可见 25 条，已扫 25 条，筛选后 15 条，只列前 10 条」
function printList(label, productId, scan, rows, limit) {
  const parts = [scanCoverage(scan, productId)];
  if (rows.length !== scan.scanned) parts.push(`筛选后 ${rows.length} 条`);
  const shown = rows.slice(0, limit);
  if (shown.length < rows.length) parts.push(`只列前 ${shown.length} 条`);
  out(`# ${label}（产品 ${productId} ${parts.join('，')}）`);
  for (const row of shown) out(row.join('\t'));
}

// 一次拉全量（--all 翻完所有页，分页不前进时退回第 1 页）+ 字段投影（--fields）+ 客户端筛选
async function cmdBugs(env, opts) {
  const productId = productIdOf(opts, 'bugs');
  const limit = listLimitOf(opts);
  const scan = await runListScan(
    ['bug', 'list', '--scope', 'products', '--scope-id', productId, '--fields', BUG_LIST_FIELDS, ...listFilterArgs(opts)],
    productId,
    env
  );
  printList(
    '缺陷',
    productId,
    scan,
    scan.rows.map((bug) => [cell(bug.id), cell(bug.title), cell(bug.status), assignee(bug.assignedTo), `${cell(bug.severity)}/${cell(bug.pri)}`]),
    limit
  );
}

async function cmdFeedbacks(env, opts) {
  const productId = productIdOf(opts, 'feedbacks');
  const limit = listLimitOf(opts);
  const scan = await runListScan(
    ['feedback', 'list', '--product-id', productId, '--fields', FEEDBACK_LIST_FIELDS, ...listFilterArgs(opts)],
    productId,
    env
  );
  printList(
    '反馈',
    productId,
    scan,
    scan.rows.map((feedback) => [cell(feedback.id), cell(feedback.title), cell(feedback.status), assignee(feedback.assignedTo)]),
    limit
  );
}

// 流水基线：--baseline-actions <动作ID,动作ID>。给了就只把基线之外的动作标成 new: true
function baselineOf(opts) {
  const raw = opts['baseline-actions'];
  if (raw === undefined) return null;
  const ids = String(raw === true ? '' : raw)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) {
    throw usage('--baseline-actions 只认动作 ID，如 --baseline-actions 11,12');
  }
  return new Set(ids);
}

// 没给基线时没有 new 字段：分不出哪条是这次新增的，就不能凭空标
function actionViews(actions, baseline) {
  return rowsOf(actions).map((action) => {
    const view = {
      id: action.id,
      action: cell(action.action),
      actor: cell(action.actor),
      date: cell(action.date),
      comment: cell(action.comment),
    };
    if (baseline) view.new = !baseline.has(String(action.id));
    // 字段级差异：禅道把改动记在 history 里，字段名是 old / new
    view.changes = rowsOf(action.history).map((change) => ({
      field: cell(change.field),
      from: cell(change.old),
      to: cell(change.new),
    }));
    return view;
  });
}

// 详情打一行 JSON：事实（字段 + 流水）原样给出，推断留给文档里的三段式
async function cmdBug(env, opts) {
  const id = recordIdOf(opts, 'bug');
  const baseline = baselineOf(opts);
  const { data } = await runCli(['bug', 'get', id, '--fields', BUG_DETAIL_FIELDS], env);
  const bug = data && typeof data === 'object' ? data : {};
  out(
    JSON.stringify({
      ok: true,
      kind: 'bug',
      id: bug.id ?? Number(id),
      product: bug.product ?? '',
      title: bug.title ?? '',
      status: bug.status ?? '',
      severity: bug.severity ?? '',
      pri: bug.pri ?? '',
      type: bug.type ?? '',
      openedBuild: bug.openedBuild ?? [],
      openedBy: bug.openedBy ?? '',
      openedDate: bug.openedDate ?? '',
      assignee: bug.assignedTo ?? '',
      processor: bug.resolvedBy ?? '',
      processedDate: bug.resolvedDate ?? '',
      resolution: bug.resolution ?? '',
      body: stripHtml(bug.steps),
      actions: actionViews(bug.actions, baseline),
    })
  );
}

async function cmdFeedback(env, opts) {
  const id = recordIdOf(opts, 'feedback');
  const baseline = baselineOf(opts);
  const { data } = await runCli(['feedback', 'get', id, '--fields', FEEDBACK_DETAIL_FIELDS], env);
  const feedback = data && typeof data === 'object' ? data : {};
  out(
    JSON.stringify({
      ok: true,
      kind: 'feedback',
      id: feedback.id ?? Number(id),
      product: feedback.product ?? '',
      title: feedback.title ?? '',
      status: feedback.status ?? '',
      type: feedback.type ?? '',
      openedBy: feedback.openedBy ?? '',
      openedDate: feedback.openedDate ?? '',
      assignee: feedback.assignedTo ?? '',
      reviewer: feedback.reviewedBy ?? '',
      reviewedDate: feedback.reviewedDate ?? '',
      processor: feedback.processedBy ?? '',
      processedDate: feedback.processedDate ?? '',
      resolution: feedback.solution ?? '',
      body: stripHtml(feedback.desc),
      actions: actionViews(feedback.actions, baseline),
    })
  );
}

// 子命令 → 处理函数 + 它认的选项。写错选项要报用法，不能悄悄按默认值跑
const COMMANDS = {
  products: { run: cmdProducts, options: [] },
  projects: { run: cmdProjects, options: ['product'] },
  bugs: { run: cmdBugs, options: ['product', 'status', 'match', 'limit'] },
  feedbacks: { run: cmdFeedbacks, options: ['product', 'status', 'match', 'limit'] },
  bug: { run: cmdBug, options: ['id', 'baseline-actions'] },
  feedback: { run: cmdFeedback, options: ['id', 'baseline-actions'] },
};

// ===== 写子命令 =====
// ----- 建缺陷单 -----

// 缺陷单的正文载体是 steps（富文本）。回读比对前先剥标签、归一化空白再逐字比：
// 服务端可能补 <p>、把换行写成 <br>、转义实体，这些都不算内容差异。
function plainText(html) {
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

// 回读只取核对要用的字段：原始单据带几十个字段，进上下文没用
const BUG_READBACK_FIELDS = 'id,title,product,steps,severity,pri,openedBuild,assignedTo,status,openedBy,actions';

/** 读缺陷单载荷：文件里放 bug create 的请求体本身，别再套一层 payload。 */
function readBugPayload(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到载荷文件：${err?.message || err}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('载荷文件不是合法 JSON：放缺陷单的请求体本身，不要再套一层 payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('载荷文件里要放一个 JSON 对象（缺陷单的请求体）');
  }
  const missing = [];
  if (!(Number(payload.productID) > 0)) missing.push('productID');
  if (!String(payload.title ?? '').trim()) missing.push('title');
  if (!Array.isArray(payload.openedBuild) || payload.openedBuild.length === 0) missing.push('openedBuild');
  if (missing.length) throw new Error(`载荷缺必填字段：${missing.join('、')}`);
  payload.productID = Number(payload.productID);
  // 禅道 CLI 校验 severity / pri 必须是有限数字，字符串会 E2009；这里先校正成数字
  for (const key of ['severity', 'pri']) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (!Number.isFinite(Number(value))) throw new Error(`载荷的 ${key} 要写数字（禅道 CLI 不接受字符串）`);
    payload[key] = Number(value);
  }
  return payload;
}

/** 本机偏好（默认负责人、默认产品）：只对本机生效，不进技能包。 */
function loadLocalPreferences(env) {
  const base = process.platform === 'win32'
    ? (env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), '.config');
  const file = env.ZENTAO_PREFERENCES_FILE || path.join(base, 'rh-zentao', 'preferences.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * 缺陷单负责人的生效顺序（ADR-0016 + ADR-0018）：终端用户明说 > 本机默认 > 随包默认 > 代码兜底。
 *   - 载荷里已经有 assignedTo（终端用户指名，或明确说不指派）→ 照原样
 *   - 随包默认是 ""＝不指派：载荷显式带空串，挡住禅道侧按产品 QD 的默认指派
 *   - 代码兜底是 "qd"＝产品 QD：载荷不带这个字段，由禅道按产品的 QD 指派
 * 返回生效来源，交付时要说明负责人是怎么来的。
 */
function resolveBugAssignee(payload, env) {
  if (payload.assignedTo !== undefined && payload.assignedTo !== null) return 'user';
  const prefs = loadLocalPreferences(env);
  const cfg = loadPackageConfig(env);
  const hasLocal = typeof prefs.bugAssignee === 'string';
  const hasPackage = typeof cfg.bugAssignee === 'string';
  const configured = String(hasLocal ? prefs.bugAssignee : hasPackage ? cfg.bugAssignee : 'qd').trim();
  if (configured === 'qd') {
    delete payload.assignedTo;
    return 'qd';
  }
  payload.assignedTo = configured;
  return hasLocal ? 'local' : 'package';
}

/** 按编号回读缺陷单（只取核对要用的字段）。 */
async function readBug(id, env) {
  const { data } = await runCli(['bug', 'get', String(id), '--fields', BUG_READBACK_FIELDS], env);
  return data && typeof data === 'object' ? data : {};
}

/**
 * 某产品下的缺陷编号：写入前拍的基线，也是结果不确定时找新记录的范围。
 * 扫不全时（服务端分页不前进，只读到第 1 页）一并交代：这种基线不能当完整依据。
 */
async function bugIdsOf(productID, env) {
  const scan = await runListScan(
    ['bug', 'list', '--scope', 'products', '--scope-id', String(productID), '--fields', 'id,product'],
    productID,
    env,
  );
  return { ...scan, ids: scan.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)) };
}

function versionListOf(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/** 回读核对：产品、标题、完整正文、影响版本、严重程度、优先级、负责人、本次新增的「创建」流水。 */
function bugMismatches(payload, bug) {
  const mismatches = [];
  if (Number(bug.product) !== Number(payload.productID)) mismatches.push('产品');
  if (String(bug.title ?? '').trim() !== String(payload.title).trim()) mismatches.push('标题');
  if (plainText(bug.steps) !== plainText(payload.steps)) mismatches.push('正文');
  if (versionListOf(bug.openedBuild).join('\n') !== versionListOf(payload.openedBuild).join('\n')) mismatches.push('影响版本');
  for (const [key, label] of [['severity', '严重程度'], ['pri', '优先级']]) {
    if (payload[key] === undefined) continue;
    if (String(bug[key] ?? '').trim() !== String(payload[key]).trim()) mismatches.push(label);
  }
  // 生效值是产品 QD 时负责人由禅道侧指派，拿不到预期值，只记录回读结果
  if (payload.assignedTo !== undefined && String(bug.assignedTo ?? '').trim() !== String(payload.assignedTo).trim()) {
    mismatches.push('负责人');
  }
  const actions = Array.isArray(bug.actions) ? bug.actions : [];
  if (!actions.some((action) => String(action?.action) === 'opened')) mismatches.push('操作流水里本次新增的「创建」');
  return mismatches;
}

// 交付时要给完整直达链接；站点地址读不到就不给链接，也不编一个
function bugLink(env, id) {
  const site = String(env.ZENTAO_URL || '').replace(/\/+$/, '');
  return site ? `${site}/bug-view-${id}.html` : null;
}

/** 建单成功的交付要素：编号、标题、状态、负责人及其来源、提交人、直达链接。 */
function emitBug(bug, assigneeSource, env, verified) {
  out(
    JSON.stringify({
      ok: true,
      kind: 'bug',
      id: Number(bug.id),
      title: bug.title ?? '',
      status: bug.status ?? '',
      assignedTo: String(bug.assignedTo ?? ''),
      assigneeSource,
      openedBy: bug.openedBy ?? '',
      url: bugLink(env, bug.id),
      verified,
    }),
  );
}

/** 单据写进去了但回读对不上：不重建，把现状交回终端用户。 */
function reportBugMismatches(id, mismatches) {
  const message = `回读核对没通过（缺陷 #${id} 已经写入）：${mismatches.join('、')}与载荷不一致。不要重建，先把单据现状告诉终端用户。`;
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: 'bug', id, created: true, mismatches, message }));
  process.exitCode = 1;
}

/** 结果不确定：不重发，交回终端用户。 */
function reportBugUncertain(message, extra = {}) {
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: 'bug', uncertain: true, ...extra, message }));
  process.exitCode = 1;
}

// 这些错误说明请求可能已经落到禅道、只是没拿到回执：先查询核实，不重发。
// CLI 的错误封装里带官方错误码：5001 超时、5003 取消、1002 地址不可达；读不懂响应同理。
function cliOutcomeUnknown(err) {
  const message = String(err?.message || '');
  return /超时/.test(message) || /（E?(500[13]|1002)）/.test(message) || /响应看不懂/.test(message);
}

/**
 * 结果不确定（超时 / 断连 / 读不懂响应）时，先查该产品的缺陷列表，只认
 * 「查重基线之外 + 唯一 + 回读完全一致」的那条；认不准就报未确认。
 * 基线本身不完整（只读到第 1 页）时这条判据不成立：直接报未确认，不拿不完整的扫描当依据。
 */
async function confirmBugByQuery(env, payload, assigneeSource, baseline, why) {
  if (!baseline.complete || baseline.foreign.count) {
    const coverage = baseline.complete
      ? `有 ${baseline.foreign.count} 条记录 product 字段是 ${baseline.foreign.products.join('/')}、不属于产品 ${payload.productID}，已丢弃`
      : `${baseline.reason}，只扫到 ${baseline.ids.length} 条`;
    reportBugUncertain(
      `${why}；写入前的查重基线不完整（${coverage}），分不出哪条是本次新建：这条缺陷是否新建未确认。不要重发。`,
      { id: null, candidates: [], baselineComplete: false },
    );
    return;
  }
  let scan;
  try {
    scan = await bugIdsOf(payload.productID, env);
  } catch (err) {
    reportBugUncertain(`${why}；重查产品 ${payload.productID} 的缺陷列表也失败（${err?.message || err}），这条缺陷是否建成都未确认。不要重发。`);
    return;
  }
  if (!scan.complete || scan.foreign.count) {
    const coverage = scan.complete
      ? `有 ${scan.foreign.count} 条记录不属于产品 ${payload.productID}，已丢弃`
      : `${scan.reason}，只扫到 ${scan.ids.length} 条`;
    reportBugUncertain(
      `${why}；重查的覆盖不完整（${coverage}），分不出哪条是本次新建：这条缺陷是否新建未确认。不要重发。`,
      { id: null, candidates: [], baselineComplete: false },
    );
    return;
  }
  const known = new Set(baseline.ids);
  const fresh = scan.ids.filter((id) => !known.has(id));
  const matched = [];
  for (const id of fresh) {
    let bug;
    try {
      bug = await readBug(id, env);
    } catch {
      continue;
    }
    if (bugMismatches(payload, bug).length === 0) matched.push(bug);
  }
  if (matched.length === 1) {
    emitBug(matched[0], assigneeSource, env, 'query');
    return;
  }
  if (matched.length > 1) {
    reportBugUncertain(
      `${why}；重查后找到多条与载荷一致的记录，无法唯一确认是哪一条，先不要重发，把候选交回终端用户。`,
      { id: null, candidates: matched.map((bug) => Number(bug.id)) },
    );
    return;
  }
  reportBugUncertain(
    `${why}；重查产品 ${payload.productID} 也没找到与载荷一致的新记录，这条缺陷是否建成未确认。不要重发，先向终端用户核实。`,
    { id: null, candidates: [] },
  );
}

// 建缺陷单：载荷落文件 → 只发一次创建 → 按返回编号回读核对 → 交付
async function cmdBugCreate(env, opts) {
  const file = String(opts['payload-file'] ?? '').trim();
  if (!file) throw usage('node zentao.mjs bug-create --payload-file <路径>（文件里放缺陷单的请求体）');
  const payload = readBugPayload(file);
  const assigneeSource = resolveBugAssignee(payload, env);
  // 补上负责人的生效载荷写回同一个临时文件：交给 CLI 的永远是文件，正文不进命令行参数
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

  try {
    // 写入前拍一次查重基线：结果不确定时，只有基线之外的编号才可能是本次新建的
    let baseline;
    try {
      baseline = await bugIdsOf(payload.productID, env);
    } catch (err) {
      throw new Error(`读不到产品 ${payload.productID} 的缺陷列表，没敢建单（先确认产品与权限）：${err?.message || err}`);
    }

    let created;
    try {
      // 只发一次：禅道创建没有幂等键，重发就是两条记录
      created = await runCli(['bug', 'create', '--data', `@${file}`], env);
    } catch (err) {
      if (!cliOutcomeUnknown(err)) throw err;
      await confirmBugByQuery(env, payload, assigneeSource, baseline, `创建请求结果不确定（${err.message}）`);
      return;
    }

    const id = Number((created.data?.bug ?? created.data)?.id);
    if (!Number.isFinite(id) || id <= 0) {
      await confirmBugByQuery(env, payload, assigneeSource, baseline, '创建响应里没有可用的缺陷编号');
      return;
    }
    let bug;
    try {
      bug = await readBug(id, env);
    } catch (err) {
      await confirmBugByQuery(env, payload, assigneeSource, baseline, `按返回的 #${id} 回读失败（${err.message}）`);
      return;
    }
    const mismatches = bugMismatches(payload, bug);
    if (mismatches.length) {
      reportBugMismatches(id, mismatches);
      return;
    }
    emitBug(bug, assigneeSource, env, 'readback');
  } finally {
    // 临时载荷文件用完删掉：正文不留在磁盘上
    fs.rmSync(file, { force: true });
  }
}

// 各票的子命令注册放在自己的分区里，免得同改 COMMANDS 字面量
Object.assign(COMMANDS, {
  'bug-create': { run: cmdBugCreate, options: ['payload-file'] },
});
// ----- 建反馈单 -----

// 反馈单的正文载体是 desc（纯文本）。回读比对前只归一化换行与行尾空白：
// 纯文本正文里可能有 < 这样的普通字符，剥标签会把内容改掉。
function plainDesc(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

// 回读只取核对要用的字段：原始单据带几十个字段，进上下文没用
const FEEDBACK_READBACK_FIELDS = 'id,title,product,type,desc,feedbackBy,openedBy,status,actions';

// 来源与模块不填：禅道反馈单不要求这两项，填了只是多余信息
const FEEDBACK_DROPPED_FIELDS = ['source', 'module'];

/**
 * 读反馈单载荷：文件里放 feedback create 的请求体本身，别再套一层 payload。
 * account 是当前禅道账号——反馈者（feedbackBy）要显式写成它：
 * 禅道不自动记录反馈者字段，不显式写就永远是空的。
 */
function readFeedbackPayload(file, account) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到载荷文件：${err?.message || err}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('载荷文件不是合法 JSON：放反馈单的请求体本身，不要再套一层 payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('载荷文件里要放一个 JSON 对象（反馈单的请求体）');
  }

  const missing = [];
  // 产品要整数形态：字符串形态会被服务端静默忽略（禅道的 --product 是 integer）
  const product = Number(payload.product);
  if (payload.product === undefined || payload.product === null || payload.product === '') {
    missing.push('product');
  } else if (!Number.isFinite(product) || product <= 0) {
    throw new Error('载荷的 product 要写数字（禅道要求整数形态，字符串会被服务端静默忽略）');
  }
  if (!String(payload.title ?? '').trim()) missing.push('title');
  if (!String(payload.desc ?? '').trim()) missing.push('desc');
  if (missing.length) throw new Error(`载荷缺必填字段：${missing.join('、')}`);

  payload.product = product;
  payload.title = String(payload.title);
  payload.desc = String(payload.desc);
  // 反馈单的正文是纯文本描述，不接受 HTML
  if (/<[a-zA-Z/!][^>]*>/.test(payload.desc)) {
    throw new Error('载荷的 desc 是纯文本描述，不要写 HTML 标签（禅道的反馈单正文就是纯文本）');
  }
  if (payload.type !== undefined && payload.type !== null) payload.type = String(payload.type);

  // 反馈者只能是当前禅道账号：反馈者就是提这条反馈的本人，填别人与交付结论矛盾
  const reporter = String(payload.feedbackBy ?? '').trim();
  if (reporter && reporter !== account) {
    throw new Error(`反馈者只能是当前禅道账号（${account}），不要在载荷里填别人的账号`);
  }
  payload.feedbackBy = account;

  for (const key of FEEDBACK_DROPPED_FIELDS) delete payload[key];
  return payload;
}

/** 按编号回读反馈单（只取核对要用的字段）。 */
async function readFeedback(id, env) {
  const { data } = await runCli(['feedback', 'get', String(id), '--fields', FEEDBACK_READBACK_FIELDS], env);
  return data && typeof data === 'object' ? data : {};
}

/**
 * 某产品下的反馈编号：写入前拍的基线，也是结果不确定时找新记录的范围。
 * 扫不全时（服务端分页不前进，只读到第 1 页）一并交代：这种基线不能当完整依据。
 */
async function feedbackIdsOf(product, env) {
  const scan = await runListScan(['feedback', 'list', '--product-id', String(product), '--fields', 'id,product'], product, env);
  return { ...scan, ids: scan.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)) };
}

/**
 * 回读核对：产品、标题、完整正文、反馈者、创建者字段、本次新增的「创建」流水。
 * 提交人核对看创建者字段（openedBy）——这台实例的反馈单留痕主体是创建者，
 * 反馈者字段（feedbackBy）禅道不代填，回读为空时不据此判不一致。
 */
function feedbackMismatches(payload, feedback) {
  const mismatches = [];
  if (Number(feedback.product) !== Number(payload.product)) mismatches.push('产品');
  if (String(feedback.title ?? '').trim() !== String(payload.title).trim()) mismatches.push('标题');
  if (plainDesc(feedback.desc) !== plainDesc(payload.desc)) mismatches.push('正文');
  const reporter = String(feedback.feedbackBy ?? '').trim();
  if (reporter && reporter !== String(payload.feedbackBy).trim()) mismatches.push('反馈者');
  // 创建者字段：字段名必须与实例一致，取不到就如实报告，不猜哪个字段是提交人
  if (!String(feedback.openedBy ?? '').trim()) mismatches.push('创建者字段（openedBy）');
  const actions = Array.isArray(feedback.actions) ? feedback.actions : [];
  if (!actions.some((action) => String(action?.action) === 'opened')) mismatches.push('操作流水里本次新增的「创建」');
  return mismatches;
}

// 交付时要给完整直达链接；站点地址读不到就不给链接，也不编一个
function feedbackLink(env, id) {
  const site = String(env.ZENTAO_URL || '').replace(/\/+$/, '');
  return site ? `${site}/feedback-view-${id}.html` : null;
}

/** 建单成功的交付要素：编号、标题、状态、反馈者、创建者（提交人）与直达链接。 */
function emitFeedback(feedback, account, env, verified) {
  const openedBy = String(feedback.openedBy ?? '');
  out(
    JSON.stringify({
      ok: true,
      kind: 'feedback',
      id: Number(feedback.id),
      title: feedback.title ?? '',
      status: feedback.status ?? '',
      product: feedback.product ?? '',
      type: feedback.type ?? '',
      // 反馈者与创建者如实转出：交付结论不能与禅道里的实际记录矛盾
      feedbackBy: String(feedback.feedbackBy ?? ''),
      openedBy,
      submitterField: 'openedBy',
      submitterIsCurrentAccount: openedBy === account,
      url: feedbackLink(env, feedback.id),
      verified,
    }),
  );
}

/** 单据写进去了但回读对不上：不重建，把现状交回终端用户。 */
function reportFeedbackMismatches(id, mismatches) {
  const note = mismatches.includes('创建者字段（openedBy）')
    ? '（本实例的创建者字段名可能与 openedBy 不同，不要猜哪个字段是提交人）'
    : '';
  const message = `回读核对没通过（反馈 #${id} 已经写入）：${mismatches.join('、')}与载荷不一致${note}。不要重建，先把单据现状告诉终端用户。`;
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: 'feedback', id, created: true, mismatches, message }));
  process.exitCode = 1;
}

/** 结果不确定：不重发，交回终端用户。 */
function reportFeedbackUncertain(message, extra = {}) {
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: 'feedback', uncertain: true, ...extra, message }));
  process.exitCode = 1;
}

/**
 * 结果不确定（超时 / 断连 / 读不懂响应）时，先查该产品的反馈列表，只认
 * 「查重基线之外 + 唯一 + 回读完全一致」的那条；认不准就报未确认。
 * 基线本身不完整（只读到第 1 页）时这条判据不成立：直接报未确认，不拿不完整的扫描当依据。
 */
async function confirmFeedbackByQuery(env, payload, account, baseline, why) {
  if (!baseline.complete || baseline.foreign.count) {
    const coverage = baseline.complete
      ? `有 ${baseline.foreign.count} 条记录 product 字段是 ${baseline.foreign.products.join('/')}、不属于产品 ${payload.product}，已丢弃`
      : `${baseline.reason}，只扫到 ${baseline.ids.length} 条`;
    reportFeedbackUncertain(
      `${why}；写入前的查重基线不完整（${coverage}），分不出哪条是本次新建：这条反馈是否新建未确认。不要重发。`,
      { id: null, candidates: [], baselineComplete: false },
    );
    return;
  }
  let scan;
  try {
    scan = await feedbackIdsOf(payload.product, env);
  } catch (err) {
    reportFeedbackUncertain(
      `${why}；重查产品 ${payload.product} 的反馈列表也失败（${err?.message || err}），这条反馈是否建成都未确认。不要重发。`,
    );
    return;
  }
  if (!scan.complete || scan.foreign.count) {
    const coverage = scan.complete
      ? `有 ${scan.foreign.count} 条记录不属于产品 ${payload.product}，已丢弃`
      : `${scan.reason}，只扫到 ${scan.ids.length} 条`;
    reportFeedbackUncertain(
      `${why}；重查的覆盖不完整（${coverage}），分不出哪条是本次新建：这条反馈是否新建未确认。不要重发。`,
      { id: null, candidates: [], baselineComplete: false },
    );
    return;
  }
  const known = new Set(baseline.ids);
  const fresh = scan.ids.filter((id) => !known.has(id));
  const matched = [];
  for (const id of fresh) {
    let feedback;
    try {
      feedback = await readFeedback(id, env);
    } catch {
      continue;
    }
    if (feedbackMismatches(payload, feedback).length === 0) matched.push(feedback);
  }
  if (matched.length === 1) {
    emitFeedback(matched[0], account, env, 'query');
    return;
  }
  if (matched.length > 1) {
    reportFeedbackUncertain(
      `${why}；重查后找到多条与载荷一致的记录，无法唯一确认是哪一条，先不要重发，把候选交回终端用户。`,
      { id: null, candidates: matched.map((feedback) => Number(feedback.id)) },
    );
    return;
  }
  reportFeedbackUncertain(
    `${why}；重查产品 ${payload.product} 也没找到与载荷一致的新记录，这条反馈是否建成未确认。不要重发，先向终端用户核实。`,
    { id: null, candidates: [] },
  );
}

// 建反馈单：载荷落文件 → 只发一次创建 → 按返回编号回读核对 → 交付
async function cmdFeedbackCreate(env, opts) {
  const file = String(opts['payload-file'] ?? '').trim();
  if (!file) throw usage('node zentao.mjs feedback-create --payload-file <路径>（文件里放反馈单的请求体）');
  const account = String(env.ZENTAO_ACCOUNT || '').trim();
  if (!account) {
    throw new Error('拿不到当前禅道账号：反馈单的反馈者要显式记成本人账号，请在本机凭据文件里写上 ZENTAO_ACCOUNT。');
  }
  const payload = readFeedbackPayload(file, account);
  // 补上反馈者的生效载荷写回同一个临时文件：交给 CLI 的永远是文件，正文不进命令行参数
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

  try {
    // 写入前拍一次查重基线：结果不确定时，只有基线之外的编号才可能是本次新建的
    let baseline;
    try {
      baseline = await feedbackIdsOf(payload.product, env);
    } catch (err) {
      throw new Error(`读不到产品 ${payload.product} 的反馈列表，没敢建单（先确认产品与权限）：${err?.message || err}`);
    }

    let created;
    try {
      // 只发一次：禅道创建没有幂等键，重发就是两条记录
      created = await runCli(['feedback', 'create', '--data', `@${file}`], env);
    } catch (err) {
      if (!cliOutcomeUnknown(err)) throw err;
      await confirmFeedbackByQuery(env, payload, account, baseline, `创建请求结果不确定（${err.message}）`);
      return;
    }

    const id = Number((created.data?.feedback ?? created.data)?.id);
    if (!Number.isFinite(id) || id <= 0) {
      await confirmFeedbackByQuery(env, payload, account, baseline, '创建响应里没有可用的反馈编号');
      return;
    }
    let feedback;
    try {
      feedback = await readFeedback(id, env);
    } catch (err) {
      await confirmFeedbackByQuery(env, payload, account, baseline, `按返回的 #${id} 回读失败（${err.message}）`);
      return;
    }
    const mismatches = feedbackMismatches(payload, feedback);
    if (mismatches.length) {
      reportFeedbackMismatches(id, mismatches);
      return;
    }
    emitFeedback(feedback, account, env, 'readback');
  } finally {
    // 临时载荷文件用完删掉：正文不留在磁盘上
    fs.rmSync(file, { force: true });
  }
}

// 各票的子命令注册放在自己的分区里，免得同改 COMMANDS 字面量
Object.assign(COMMANDS, {
  'feedback-create': { run: cmdFeedbackCreate, options: ['payload-file'] },
});
// ----- 更新单据 -----

// 追加草稿的分隔行：草稿 = 原文 + 分隔行 + 标注 + 追加段落。
// 文档（references/workflow.md F4）给终端用户看的草稿与脚本拆草稿用的是同一条线。
const APPEND_SEPARATOR = /^[─—\-=]{3,}$/;

// 两种单据的正文载体与对应的禅道更新动作
const UPDATE_KINDS = {
  feedback: { label: '反馈单', bodyField: 'desc', cli: 'feedback', readFields: 'id,title,product,status,desc,actions' },
  bug: { label: '缺陷单', bodyField: 'steps', cli: 'bug', readFields: 'id,title,product,status,steps,actions' },
};

/**
 * 正文归一化：比较前统一实体与空白，服务端的排版差异（补 <p>、写 &nbsp;、改换行）不算内容差异。
 * 缺陷单正文是 HTML，先剥标签；反馈单正文是纯文本，只归一化空白。
 */
function normalizeBody(text, kindName) {
  const raw = kindName === 'bug' ? plainText(text) : String(text ?? '');
  return raw
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== ''))
    .join('\n')
    .trim();
}

/**
 * 拆追加草稿：原文部分 + 追加部分（分隔行及其之后）。
 * 用 expectedBody（用户确认时看到的那份原文）定位分界：草稿的原文部分必须与它一致。
 */
function splitAppendDraft(draft, expectedBody, kindName) {
  const lines = String(draft).split('\n');
  const cuts = [];
  lines.forEach((line, index) => {
    if (APPEND_SEPARATOR.test(line.trim())) cuts.push(index);
  });
  if (!cuts.length) {
    return { error: '草稿里找不到分隔行：追加草稿要是「原文 + 分隔行 + 标注 + 追加段落」' };
  }
  for (const cut of cuts) {
    const original = lines.slice(0, cut).join('\n');
    if (normalizeBody(original, kindName) === normalizeBody(expectedBody, kindName)) {
      return { original, appended: lines.slice(cut).join('\n') };
    }
  }
  return { error: '草稿的原文部分与 expectedBody 对不上：expectedBody 要写用户确认时看到的那份原文' };
}

/**
 * 读更新载荷：请求体 + expectedBody（用户确认时看到的那份原文，写前复核的基准）。
 */
function readUpdatePayload(kindName, file) {
  const kind = UPDATE_KINDS[kindName];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到载荷文件：${err?.message || err}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('载荷文件不是合法 JSON：放更新请求体本身，不要再套一层 payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('载荷文件里要放一个 JSON 对象（更新请求体）');
  }
  const body = payload[kind.bodyField];
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error(`载荷缺 ${kind.bodyField}：要写完整的更新正文（原文 + 分隔行 + 标注 + 追加段落）`);
  }
  if (typeof payload.expectedBody !== 'string') {
    throw new Error('载荷缺 expectedBody：写前复核要知道用户确认时看到的那份原文');
  }
  return { body, expectedBody: payload.expectedBody, title: payload.title, product: payload.product };
}

/** 按编号读一条单据（这条路径要用的字段：正文、标题、产品、状态、流水）。 */
async function readUpdateRecord(kindName, id, env) {
  const kind = UPDATE_KINDS[kindName];
  const { data } = await runCli([kind.cli, 'get', String(id), '--fields', kind.readFields], env);
  const record = data && typeof data === 'object' ? data : {};
  return {
    body: String(record[kind.bodyField] ?? ''),
    title: String(record.title ?? ''),
    product: record.product ?? '',
    status: String(record.status ?? ''),
    actions: rowsOf(record.actions),
  };
}

/** 流水基线：写前复核读到的动作 ID。 */
function actionIds(actions) {
  return new Set(rowsOf(actions).map((action) => String(action.id)));
}

/** 本次新增的「编辑」：基线之外、动作是 edited 的那几条。历史上存在过 edited 不算证据。 */
function newEditedActions(actions, baseline) {
  return rowsOf(actions).filter((action) => !baseline.has(String(action.id)) && String(action.action) === 'edited');
}

/** 回读核对：完整预期正文归一化后逐字比较，并确认本次新增了「编辑」。 */
function updateMismatches(expectedBody, before, after, kindName) {
  const mismatches = [];
  if (normalizeBody(after.body, kindName) !== normalizeBody(expectedBody, kindName)) mismatches.push('正文');
  if (!newEditedActions(after.actions, actionIds(before.actions)).length) mismatches.push('操作流水里本次新增的「编辑」');
  return mismatches;
}

/** 写前复核发现单据被改过：停手，把当前原文与重新合并后的草稿交回终端用户。 */
function reportUpdateConflict(kindName, id, changed, current, mergedDraft) {
  const kind = UPDATE_KINDS[kindName];
  const message =
    `这条${kind.label}在你确认期间被改过（${changed.join('、')}变了），我还没写入。` +
    '下面是它现在的原文和我重新合并后的草稿，确认后我再更新。';
  process.stderr.write(`错误：${message}\n`);
  out(
    JSON.stringify({
      ok: false,
      kind: kindName,
      id: Number(id),
      conflict: true,
      changed,
      currentBody: current.body,
      currentBodyText: normalizeBody(current.body, kindName),
      mergedDraft,
      mergedDraftText: normalizeBody(mergedDraft, kindName),
      message,
    })
  );
  process.exitCode = 1;
}

/** 单据写进去了但回读对不上：不重放更新，把现状交回终端用户。 */
function reportUpdateMismatch(kindName, id, mismatches) {
  const kind = UPDATE_KINDS[kindName];
  const message = `回读核对没通过（${kind.label} #${id} 已经写入）：${mismatches.join('、')}与预期不一致。不要重放更新，先把单据现状告诉终端用户。`;
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: kindName, id: Number(id), updated: true, mismatches, message }));
  process.exitCode = 1;
}

/** 结果不确定：只读核实过还是没核实成，都不重放更新。 */
function reportUpdateUncertain(kindName, id, message, extra = {}) {
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: kindName, id: Number(id), uncertain: true, ...extra, message }));
  process.exitCode = 1;
}

/**
 * 结果不确定（超时 / 断连 / 读不懂响应）时只读核实：正文与预期一致、且本次新增了「编辑」，
 * 才算写进去了；核实不了就报未确认。任何情况下都不重放更新。
 */
async function verifyUpdateByRead(kindName, id, env, bodyToWrite, before, why) {
  let after;
  try {
    after = await readUpdateRecord(kindName, id, env);
  } catch (err) {
    reportUpdateUncertain(kindName, id, `${why}；回读核实也失败（${err?.message || err}），这次补充说明是否写进去未确认。不要重放更新。`);
    return;
  }
  const mismatches = updateMismatches(bodyToWrite, before, after, kindName);
  if (!mismatches.length) {
    out(
      JSON.stringify({
        ok: true,
        kind: kindName,
        id: Number(id),
        title: after.title,
        status: after.status,
        updated: true,
        verified: 'query',
        newActions: newEditedActions(after.actions, actionIds(before.actions)).map((action) => String(action.action)),
      })
    );
    return;
  }
  reportUpdateUncertain(kindName, id, `${why}；回读核实发现${mismatches.join('、')}与预期不一致，这次补充说明是否写进去未确认。不要重放更新。`, {
    mismatches,
  });
}

/**
 * 更新单据（补充说明走这条通道）：写前复核 → 只发一次更新 → 回读核对。
 * 禅道没有「只评论不改状态」的接口，补充说明就是改正文；
 * 禅道更新接口无条件覆盖、没有版本号 CAS，所以写入前要再读一次核对原文。
 */
async function cmdUpdate(kindName, env, opts) {
  const kind = UPDATE_KINDS[kindName];
  const file = String(opts['payload-file'] ?? '').trim();
  if (!file) throw usage(`node zentao.mjs ${kindName}-update --id <单据ID> --payload-file <路径>`);
  const id = recordIdOf(opts, `${kindName}-update`);
  const payload = readUpdatePayload(kindName, file);

  const draft = splitAppendDraft(payload.body, payload.expectedBody, kindName);
  if (draft.error) throw new Error(draft.error);

  // 写前复核：再读一次当前单据，正文/标题/产品与用户确认时看到的那份对不上就停手
  const current = await readUpdateRecord(kindName, id, env);
  const changed = [];
  if (normalizeBody(current.body, kindName) !== normalizeBody(payload.expectedBody, kindName)) changed.push('正文');
  if (payload.title !== undefined && String(payload.title) !== current.title) changed.push('标题');
  if (payload.product !== undefined && Number(payload.product) !== Number(current.product)) changed.push('产品');
  if (changed.length) {
    // 停手：把当前原文与重新合并后的草稿交回终端用户重新确认，不写入
    const mergedDraft = `${current.body}\n\n${draft.appended}`;
    reportUpdateConflict(kindName, id, changed, current, mergedDraft);
    return;
  }

  // 写进去的正文：服务端那份当前原文原样保留 + 追加段落（追加段落单独标出来）
  const bodyToWrite = `${current.body}\n\n${draft.appended}`;
  // 交给禅道的请求体：标题与产品沿用当前值；正文只走文件，不进命令行参数
  const cliPayload =
    kindName === 'feedback'
      ? { product: Number(current.product), title: current.title, desc: bodyToWrite }
      : { title: current.title, steps: bodyToWrite };
  fs.writeFileSync(file, JSON.stringify(cliPayload), { mode: 0o600 });

  try {
    try {
      // 只发一次更新：禅道更新接口无条件覆盖，重放就是把同一份内容再盖一遍
      await runCli([kind.cli, 'update', String(id), '--data', `@${file}`], env);
    } catch (err) {
      if (!cliOutcomeUnknown(err)) throw err;
      await verifyUpdateByRead(kindName, id, env, bodyToWrite, current, `更新请求结果不确定（${err.message}）`);
      return;
    }

    const after = await readUpdateRecord(kindName, id, env);
    const mismatches = updateMismatches(bodyToWrite, current, after, kindName);
    if (mismatches.length) {
      reportUpdateMismatch(kindName, id, mismatches);
      return;
    }
    out(
      JSON.stringify({
        ok: true,
        kind: kindName,
        id: Number(id),
        title: after.title,
        status: after.status,
        updated: true,
        verified: 'readback',
        newActions: newEditedActions(after.actions, actionIds(current.actions)).map((action) => String(action.action)),
      })
    );
  } finally {
    // 临时载荷文件用完删掉：正文不留在磁盘上
    fs.rmSync(file, { force: true });
  }
}

Object.assign(COMMANDS, {
  'feedback-update': { run: (env, opts) => cmdUpdate('feedback', env, opts), options: ['id', 'payload-file'] },
  'bug-update': { run: (env, opts) => cmdUpdate('bug', env, opts), options: ['id', 'payload-file'] },
});
// ----- 传图 -----

// 禅道单文件上限 50 MiB（CLI 的 multipart 上传也是这个限）
const FILE_MAX_BYTES = 50 * 1024 * 1024;

// 图片能挂的对象。CLI 的 --object-type 帮助文本只列 bug/story/task/testcase，
// 但它没有 enum 校验：feedback 会原样透传给服务端并绑定成功（证据：issue #13 判据③）。
const FILE_OBJECT_TYPES = ['bug', 'feedback'];

/** 扩展名小写、不带点；没有扩展名按 png 记（引用里的 t 参数就是它）。 */
function imageExtensionOf(file) {
  return path.extname(file).replace(/^\./, '').toLowerCase() || 'png';
}

/** 正文里用的图片引用：相对路径 + 文件 ID，不内联 base64。 */
function buildReference(fileId, ext) {
  return `<img src="/index.php?m=file&f=read&t=${ext}&fileID=${fileId}" alt="file-read-${fileId}.${ext}" />`;
}

/** 上传返回的文件标识：CLI 把服务端的 file 对象放在 data.file 里（实测）。 */
function fileIdOf(data) {
  const file = data && typeof data === 'object' ? data.file ?? data : {};
  const id = file?.id ?? data?.fileID ?? String(file?.url ?? '').match(/fileID=(\d+)/)?.[1];
  return id === undefined || id === null || id === '' ? '' : String(id);
}

/** 上传结果不确定：不重传（上传没有幂等键，重复会多出附件），交回终端用户。 */
function reportFileUncertain(message, extra = {}) {
  process.stderr.write(`错误：${message}\n`);
  out(JSON.stringify({ ok: false, kind: 'file', uncertain: true, ...extra, message }));
  process.exitCode = 1;
}

/**
 * 传图：把图片挂到**已存在的**单据上，拿到文件标识后给出正文用的图片引用。
 * 只上传、不改正文：顺序是建单 → 传图 → 更新正文（上传要带单据类型与单据 ID）。
 */
async function cmdFileCreate(env, opts) {
  const usageText = 'node zentao.mjs file-create --file <图片路径> --object-type <bug|feedback> --object-id <单据ID>';
  const wanted = String(opts.file ?? '').trim();
  if (!wanted) throw usage(usageText);
  const objectType = String(opts['object-type'] ?? '').trim();
  if (!FILE_OBJECT_TYPES.includes(objectType)) throw usage(`${usageText}（--object-type 只能是 bug 或 feedback）`);
  const objectId = String(opts['object-id'] ?? '').trim();
  if (!/^\d+$/.test(objectId)) throw usage(`${usageText}（单据 ID 是数字）`);

  // 相对路径按命令执行目录解析：调用者在哪个目录下跑，图就从哪儿找
  const file = path.resolve(wanted);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new Error(`找不到图片文件：${file}`);
  }
  if (size > FILE_MAX_BYTES) {
    throw new Error(`图片 ${Math.ceil(size / 1024 / 1024)} MiB，超过禅道单文件上限 50 MiB；先压缩再上传。`);
  }

  let payload;
  try {
    payload = await runCli(['file', 'create', '--file', file, '--object-type', objectType, '--object-id', objectId], env);
  } catch (err) {
    // 没拿到回执：图片可能已经传上去了，先查单据里有没有多出附件，不重传
    if (cliOutcomeUnknown(err)) {
      reportFileUncertain(
        `传图结果不确定（${err.message}）：图片可能已经挂上去了。先到单据里看有没有多出这个附件，不要直接重传。`,
        { objectType, objectId: Number(objectId) }
      );
      return;
    }
    throw new Error(`传图失败（${objectType} #${objectId}）：图片没有传上去。${err.message}`);
  }

  const fileId = fileIdOf(payload.data);
  if (!fileId) {
    throw new Error(
      `上传返回里没有文件标识（挂载对象 ${objectType} #${objectId}），没法生成图片引用。先查单据里有没有多出附件，不要重传。`
    );
  }
  const extension = imageExtensionOf(file);
  out(
    JSON.stringify({
      ok: true,
      kind: 'file',
      fileId: /^\d+$/.test(fileId) ? Number(fileId) : fileId,
      objectType,
      objectId: Number(objectId),
      extension,
      reference: buildReference(fileId, extension),
    })
  );
}

// 各票的子命令注册放在自己的分区里，免得同改 COMMANDS 字面量
Object.assign(COMMANDS, {
  'file-create': { run: cmdFileCreate, options: ['file', 'object-type', 'object-id'] },
});
// ===== 查重子命令 =====

// 查重只投影这几个字段：候选要列编号、标题、状态、负责人，正文不进上下文；
// product 也取来，用于归属校验（回退取回的记录可能不是这个产品的）
const DUP_LIST_FIELDS = 'id,title,status,assignedTo,product';
// 候选最多列多少行：候选是给人挑的，列太多挑不动
const DUP_CANDIDATE_LIMIT = 10;

// 查重扫描：标题切成关键词变体组，交给禅道 CLI 在客户端匹配（组内=且、组间=或，只在标题里找）。
// 匹配一律在客户端做——服务端 filters 在当前禅道版本上会被忽略（证据见 issue #13）。
async function cmdDup(env, opts) {
  const kind = String(opts.kind ?? '').trim();
  if (kind !== 'bug' && kind !== 'feedback') {
    throw usage('node zentao.mjs dup --kind <bug|feedback> --product <产品ID> --title <标题>');
  }
  const productId = productIdOf(opts, 'dup');
  const title = String(opts.title ?? '').trim();
  if (!title) throw usage('node zentao.mjs dup --kind <bug|feedback> --product <产品ID> --title <标题>');

  const groups = variantGroups(title);
  if (!groups.length) throw usage('--title 里没有可用于查重的关键词');

  const listArgs =
    kind === 'bug'
      ? ['bug', 'list', '--scope', 'products', '--scope-id', productId]
      : ['feedback', 'list', '--product-id', productId];

  // 全量扫描：既是候选的来源，也是写入时的查重基线
  const all = await runListScan([...listArgs, '--fields', DUP_LIST_FIELDS], productId, env);
  const rows = all.rows;
  const baseline = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));

  // 变体组交给 CLI：一次 --search 一组（组内=且），多组之间=或；--search-fields title 把检索范围限制在标题
  const searchArgs = [];
  for (const group of groups) searchArgs.push('--search', group);
  searchArgs.push('--search-fields', 'title');
  const found = await runListScan([...listArgs, '--fields', DUP_LIST_FIELDS, ...searchArgs], productId, env);
  const hits = found.rows;

  // 精确度自己把关：CLI 只给候选，覆盖比例不到门槛的丢掉，剩下的按匹配度降序
  const candidates = rankByMatch(title, hits, (row) => row.title, hits.length).map((row) => ({
    row,
    score: matchScore(title, row.title),
  }));

  // 两次扫描碰上同一条分页缺陷：任一次没扫全，整次查重就算覆盖不完整
  const complete = all.complete && found.complete;
  const reason = all.complete ? found.reason : all.reason;
  // 丢弃的异物记录按基线那次扫描来说（另一次只是同一批记录的检索视图，相加会重复计）
  const foreign = all.foreign;

  const label = kind === 'bug' ? '缺陷' : '反馈';
  out(`# 查重（产品 ${productId} · ${label}单；标题关键词匹配，客户端完成）`);
  for (const { row, score } of candidates.slice(0, DUP_CANDIDATE_LIMIT)) {
    out(
      [cell(row.id), cell(row.title), cell(row.status), assignee(row.assignedTo), `${Math.round(score * 100)}%`].join('\t')
    );
  }
  const hitsNote = `（在标题里命中 ${hits.length} 条）`;
  const droppedNote = foreign.count
    ? `；另有 ${foreign.count} 条返回记录 product 字段是 ${foreign.products.join('/')}，不属于产品 ${productId}，已丢弃`
    : '';
  if (complete && !foreign.count) {
    const scope = candidates.length
      ? `在你可见的 ${rows.length} 条${label}中发现 ${candidates.length} 条相近记录`
      : `在你可见的 ${rows.length} 条${label}中未发现重复`;
    out(`# 覆盖范围：${scope}${hitsNote}`);
  } else if (complete) {
    const scope = candidates.length
      ? `在这 ${rows.length} 条${label}中发现 ${candidates.length} 条相近记录`
      : `在这 ${rows.length} 条${label}中未发现重复`;
    out(`# 覆盖范围：${scope}${hitsNote}${droppedNote}`);
  } else {
    // 没扫全就不说「在你可见的 N 条中未发现重复」：那是把第 1 页当成了全部
    const scope = candidates.length
      ? `这 ${rows.length} 条里发现 ${candidates.length} 条相近记录`
      : `这 ${rows.length} 条里未发现重复`;
    const claim = all.total > rows.length + foreign.count ? `，服务端称共有 ${all.total} 条` : '';
    out(`# 覆盖范围：只扫到 ${rows.length} 条${label}${claim}，${reason}，覆盖不完整——${scope}，不等于全部可见记录里没有${hitsNote}${droppedNote}`);
  }
  out(
    complete && !foreign.count
      ? `# 基线（本次扫描到的 ${baseline.length} 个单据 ID；基线之外的编号才可能是本次新建）`
      : `# 基线（本次只扫到 ${baseline.length} 个单据 ID，${complete ? '有记录不属于本产品、' : `${reason}、`}基线不完整；写入后不能用它判断哪些是本次新建）`
  );
  out(
    JSON.stringify({
      ok: true,
      kind,
      product: Number(productId),
      scanned: rows.length,
      complete: complete && !foreign.count,
      total: all.total,
      foreignRecords: foreign.count,
      candidateIds: candidates.map((entry) => Number(entry.row.id)),
      baseline,
    })
  );
}

// 各票的子命令注册放在自己的分区里，免得同改 COMMANDS 字面量
Object.assign(COMMANDS, {
  dup: { run: cmdDup, options: ['kind', 'product', 'title'] },
});

// ---------------------------------------------------------------- 入口

const HELP = `禅道入口脚本（rh-product-feedback）

  products                     当前账号可见的产品（这就是后续选品范围）
  projects [--product <产品ID>]  可见项目；给产品 ID 就只看它下面的

环境变量：ZENTAO_WEB_URL 覆盖禅道站点地址  ZENTAO_CREDENTIALS_FILE 覆盖本机凭据文件路径
认证：脚本用本机凭据换当次令牌，经环境变量注入官方禅道 CLI；令牌不进命令行、不打印、不落盘。
其余子命令（单据列表与详情、建单、更新、传图、查重）在迁移中陆续补齐，见 references/zentao-cli.md。`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || opts.help) {
    out(HELP);
    return;
  }
  const command = COMMANDS[cmd];
  if (!command) {
    out(HELP);
    throw usage(`未知子命令：${cmd}`);
  }
  const unknown = Object.keys(opts).filter((key) => key !== 'help' && !command.options.includes(key));
  if (unknown.length) {
    out(HELP);
    throw usage(`${cmd} 不认这些选项：${unknown.map((key) => `--${key}`).join('、')}`);
  }
  await command.run(await connect(process.env), opts);
}

main().catch((err) => {
  const message = err?.message || String(err);
  process.stderr.write(`错误：${message}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
});
