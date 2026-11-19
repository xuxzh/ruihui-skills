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
function cliFailure(stderr) {
  try {
    const body = JSON.parse(String(stderr || ''));
    const code = body?.error?.code ? `（${body.error.code}）` : '';
    if (body?.error?.message) return new Error(`禅道 CLI 报错${code}：${body.error.message}`);
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

// 缺陷列表投影：够判断「到哪了」的字段，正文不进表格
const BUG_LIST_FIELDS = 'id,title,status,assignedTo,severity,pri';
const FEEDBACK_LIST_FIELDS = 'id,title,status,assignedTo';
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

// 表头说清范围：「产品 101 可见 25 条，筛选后 15 条，只列前 10 条」
function printList(label, productId, total, rows, limit) {
  const parts = [`产品 ${productId} 可见 ${total} 条`];
  if (rows.length !== total) parts.push(`筛选后 ${rows.length} 条`);
  const shown = rows.slice(0, limit);
  if (shown.length < rows.length) parts.push(`只列前 ${shown.length} 条`);
  out(`# ${label}（${parts.join('，')}）`);
  for (const row of shown) out(row.join('\t'));
}

// 一次拉全量（--all 翻完所有页）+ 字段投影（--fields）+ 客户端筛选
async function cmdBugs(env, opts) {
  const productId = productIdOf(opts, 'bugs');
  const limit = listLimitOf(opts);
  const { data, meta } = await runCli(
    ['bug', 'list', '--scope', 'products', '--scope-id', productId, '--all', '--fields', BUG_LIST_FIELDS, ...listFilterArgs(opts)],
    env
  );
  const bugs = rowsOf(data);
  printList(
    '缺陷',
    productId,
    Number(meta?.total ?? bugs.length),
    bugs.map((bug) => [cell(bug.id), cell(bug.title), cell(bug.status), assignee(bug.assignedTo), `${cell(bug.severity)}/${cell(bug.pri)}`]),
    limit
  );
}

async function cmdFeedbacks(env, opts) {
  const productId = productIdOf(opts, 'feedbacks');
  const limit = listLimitOf(opts);
  const { data, meta } = await runCli(
    ['feedback', 'list', '--product-id', productId, '--all', '--fields', FEEDBACK_LIST_FIELDS, ...listFilterArgs(opts)],
    env
  );
  const feedbacks = rowsOf(data);
  printList(
    '反馈',
    productId,
    Number(meta?.total ?? feedbacks.length),
    feedbacks.map((feedback) => [cell(feedback.id), cell(feedback.title), cell(feedback.status), assignee(feedback.assignedTo)]),
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
// ----- 建反馈单 -----
// ----- 更新单据 -----
// ----- 传图 -----
// ===== 查重子命令 =====

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
