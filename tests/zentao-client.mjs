// 入口脚本适配器：以子进程方式调 skills/rh-product-feedback/scripts/zentao.mjs <子命令>，
// 把 stdout 解析回结构化结果。
//
// 供 tests/skill-flow.mjs（技能流程的可执行参考实现）、tests/e2e-mock.mjs（模拟层端到端）
// 与 tests/e2e-live-flow.mjs（真实端到端）共用。测试只从这里进：断言的是「脚本对禅道说了什么、
// Agent 拿到什么」，入口脚本内部怎么拼参数不在测试的关注点里。
//
// 表格输出（列表类）解析成行数组；详情与写入类解析成那一行 JSON。
//
// 这里也是 tests/zentao-cli-*.mjs 的共用测试脚手架（起假服务、隔离本机配置、跑子进程、替身 CLI）：
// 那几支测试打的是同一个 seam，脚手架只留一份，改一次就全生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS, createMockApiState, startMockApi } from './mock-zentao-api.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY_SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao.mjs');

/** 从环境变量叠加仓库根 .env（凭据只读不打印、不写进仓库）。 */
export function loadEnv(file = path.join(ROOT, '.env')) {
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

/** 官方禅道 CLI 的可执行文件在不在 PATH 里；没装就别假装测过。 */
export function findZentaoCli() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // 继续找下一个目录
    }
  }
  return '';
}

// ---------------------------------------------------------------- 共用测试脚手架

/** 本机接入凭据文件（写的是假服务认可的账号密码）。 */
export function writeCredentials(dir, { account = MOCK_API_ACCOUNT, password = MOCK_API_ACCOUNTS[account] } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

/**
 * 跑一次随包脚本子进程，返回 { code, stdout, stderr }。
 * 脚本是子进程、假服务跑在当前进程里，所以必须异步：同步等待会卡住事件循环，假服务就没人应答。
 */
export function runScript(script, args, env, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, ...env }, cwd },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** 跑一次入口脚本（zentao.mjs）。 */
export function runEntryScript(args, env, opts) {
  return runScript(ENTRY_SCRIPT, args, env, opts);
}

/** 替身 CLI：把收到的命令行参数记进 RH_CLI_SHIM_LOG，再原样交给 RH_CLI_REAL（真的禅道 CLI）。 */
export const CLI_SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

/**
 * 在 dir/bin 里装一个替身 CLI；返回放它进 PATH 的环境变量、argv 日志路径与读日志的 calls()。
 * source 默认是纯记录 + 转发的替身；要测「CLI 给了看不懂的响应」这类分支就传自己的替身源码。
 */
export function installCliShim(dir, realCli, { source = CLI_SHIM_SOURCE } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
  fs.writeFileSync(shim, source);
  fs.chmodSync(shim, 0o755);
  const argvLog = path.join(dir, 'cli-argv.log');
  return {
    argvLog,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RH_CLI_SHIM_LOG: argvLog, RH_CLI_REAL: realCli },
    /** 替身 CLI 收到的每次 argv。 */
    calls: () => fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

/**
 * 起假禅道 API 服务 + 一套隔离的本机配置，跑完自动收拾。
 *
 * options：
 *   tag         临时目录前缀（一眼看出是哪支测试）
 *   seed        (state) => void，起服务前往状态里塞种子数据
 *   credentials 是否写本机凭据（默认写）
 *   account / password 换成别的账号密码（测凭据无效）
 *   config      config.local.json 的内容（不给就用仓库里那份）
 *   preferences 本机偏好文件的内容（不给就没有这个文件）
 *   其余键原样交给 createMockApiState（products / bugs / failPaths 等状态注入）
 */
export async function withMockApi({ tag = 'rh-cli', seed, credentials = true, account, password, config, preferences, ...overrides } = {}, fn) {
  const state = createMockApiState(overrides);
  if (typeof seed === 'function') seed(state);
  const server = await startMockApi(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: credentials ? writeCredentials(dir, { account, password }) : path.join(dir, 'missing'),
  };
  if (config) {
    const file = path.join(dir, 'config.local.json');
    fs.writeFileSync(file, JSON.stringify({ zentaoWebUrl: server.url, ...config }));
    env.ZENTAO_PACKAGE_CONFIG_FILE = file;
  }
  if (preferences) {
    const file = path.join(dir, 'preferences.json');
    fs.writeFileSync(file, JSON.stringify(preferences));
    env.ZENTAO_PREFERENCES_FILE = file;
  }
  try {
    await fn({ server, state: server.state, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function execFileAsync(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** 输出里最后一行的 JSON（详情/写入只有一行；查重的结论在最后一行）。 */
function jsonOf(stdout) {
  const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // 继续往前找
    }
  }
  return null;
}

/** 表格式输出：# 开头的说明行 + 制表符分隔的数据行。 */
function tableOf(stdout) {
  const lines = String(stdout || '').split('\n');
  const notes = lines.filter((line) => line.startsWith('# ')).map((line) => line.slice(2));
  const rows = lines
    .filter((line) => line && !line.startsWith('#') && !line.trimStart().startsWith('{'))
    .map((line) => line.split('\t'));
  return { notes, rows };
}

function countIn(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? Number(match[1]) : null;
}

/** 一行 JSON 的写入/更新结果；失败时也返回那一行（ok:false），由调用方决定怎么处理。 */
function resultOf({ code, stdout, stderr }) {
  return { code, data: jsonOf(stdout), stdout, stderr };
}

export class ZentaoEntry {
  /**
   * @param {object} opts
   * @param {object} [opts.env] 入口脚本子进程的环境变量（站点地址、凭据文件、本机偏好等）
   * @param {string} [opts.script] 入口脚本路径（默认随包那份）
   * @param {number} [opts.timeoutMs] 单次子进程超时
   */
  constructor({ env = {}, script = ENTRY_SCRIPT, timeoutMs = 300000 } = {}) {
    this.env = env;
    this.script = script;
    this.timeoutMs = timeoutMs;
  }

  /** 原样跑一次入口脚本，返回 { code, stdout, stderr }。 */
  run(args) {
    return execFileAsync(process.execPath, [this.script, ...args], {
      env: { ...process.env, ...this.env },
      timeout: this.timeoutMs,
    });
  }

  /** 跑一次并解析最后一行的 JSON。 */
  async json(args) {
    return resultOf(await this.run(args));
  }

  // ---------------------------------------------------------------- 只读

  async products() {
    const { code, stdout, stderr } = await this.run(['products']);
    const { notes, rows } = tableOf(stdout);
    return {
      code,
      stderr,
      data: jsonOf(stdout),
      header: notes[0] || '',
      count: countIn(notes[0], /可见 (\d+) 个/),
      rows: rows.map(([id, name, qd]) => ({ id: Number(id), name, qd })),
    };
  }

  /** 产品 QD：账号、姓名、账号状态、最后登录（键名 → 值）。 */
  async qd(product) {
    const { code, stdout, stderr } = await this.run(['qd', '--product', String(product)]);
    const { notes, rows } = tableOf(stdout);
    return {
      code,
      stdout,
      stderr,
      header: notes[0] || '',
      notes,
      fields: Object.fromEntries(rows.map(([key, value]) => [key, value])),
    };
  }

  async projects(productId) {
    const args = ['projects'];
    if (productId !== undefined && productId !== null) args.push('--product', String(productId));
    const { code, stdout, stderr } = await this.run(args);
    const { notes, rows } = tableOf(stdout);
    return {
      code,
      stderr,
      data: jsonOf(stdout),
      header: notes[0] || '',
      count: countIn(notes[0], /(\d+) 个，其中进行中/),
      doing: countIn(notes[0], /其中进行中 (\d+) 个/),
      rows: rows.map(([id, name, status]) => ({ id: Number(id), name, status })),
    };
  }

  async bugs(productId, { status, match, limit } = {}) {
    const args = ['bugs', '--product', String(productId)];
    if (status) args.push('--status', status);
    if (match) args.push('--match', match);
    if (limit) args.push('--limit', String(limit));
    const { code, stdout, stderr } = await this.run(args);
    const { notes, rows } = tableOf(stdout);
    const header = notes[0] || '';
    return {
      code,
      stderr,
      data: jsonOf(stdout),
      header,
      total: countIn(header, /可见 (\d+) 条/),
      filtered: countIn(header, /筛选后 (\d+) 条/),
      rows: rows.map(([id, title, rowStatus, assignedTo, severityPri]) => {
        const [severity, pri] = String(severityPri || '').split('/');
        return { id: Number(id), title, status: rowStatus, assignedTo, severity, pri };
      }),
    };
  }

  async feedbacks(productId, { status, match, limit } = {}) {
    const args = ['feedbacks', '--product', String(productId)];
    if (status) args.push('--status', status);
    if (match) args.push('--match', match);
    if (limit) args.push('--limit', String(limit));
    const { code, stdout, stderr } = await this.run(args);
    const { notes, rows } = tableOf(stdout);
    const header = notes[0] || '';
    return {
      code,
      stderr,
      data: jsonOf(stdout),
      header,
      total: countIn(header, /可见 (\d+) 条/),
      filtered: countIn(header, /筛选后 (\d+) 条/),
      rows: rows.map(([id, title, rowStatus, assignedTo]) => ({ id: Number(id), title, status: rowStatus, assignedTo })),
    };
  }

  async bug(id, { baselineActions } = {}) {
    const args = ['bug', '--id', String(id)];
    if (baselineActions) args.push('--baseline-actions', String(baselineActions));
    return this.json(args);
  }

  async feedback(id, { baselineActions } = {}) {
    const args = ['feedback', '--id', String(id)];
    if (baselineActions) args.push('--baseline-actions', String(baselineActions));
    return this.json(args);
  }

  async dup({ kind, product, title }) {
    const { code, stdout, stderr } = await this.run(['dup', '--kind', kind, '--product', String(product), '--title', title]);
    const { notes, rows } = tableOf(stdout);
    return { code, stderr, notes, rows, data: jsonOf(stdout) };
  }

  // ---------------------------------------------------------------- 写入

  /** 载荷落临时文件：正文不进命令行参数，与技能实际的调用方式一致。 */
  writePayload(payload) {
    const file = path.join(os.tmpdir(), `rh-zentao-payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    return file;
  }

  async createBug(payload) {
    return resultOf(await this.run(['bug-create', '--payload-file', this.writePayload(payload)]));
  }

  async createFeedback(payload) {
    return resultOf(await this.run(['feedback-create', '--payload-file', this.writePayload(payload)]));
  }

  async updateBug(id, payload) {
    return resultOf(await this.run(['bug-update', '--id', String(id), '--payload-file', this.writePayload(payload)]));
  }

  async updateFeedback(id, payload) {
    return resultOf(await this.run(['feedback-update', '--id', String(id), '--payload-file', this.writePayload(payload)]));
  }

  async fileCreate({ file, objectType, objectId }) {
    return resultOf(
      await this.run(['file-create', '--file', file, '--object-type', objectType, '--object-id', String(objectId)]),
    );
  }

  // ---------------------------------------------------------------- 入口脚本还没有的动作

  /** 本机接入凭据（删除这类入口脚本还没封装的动作要自己换令牌/带密码）。 */
  readCredentials() {
    const file = this.env.ZENTAO_CREDENTIALS_FILE;
    const creds = {};
    if (!file || !fs.existsSync(file)) return creds;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      creds[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return creds;
  }

  /**
   * 删除一条单据：真实端到端清理专用（入口脚本只读、写、传图，没有删除子命令）。
   * 仍走同一条官方禅道 CLI 通道，凭据由环境变量注入 CLI 进程。
   */
  async deleteRecord(kind, id) {
    const creds = this.readCredentials();
    const account = String(this.env.ZENTAO_ACCOUNT || creds.ZENTAO_ACCOUNT || '');
    const password = String(this.env.ZENTAO_PASSWORD || creds.ZENTAO_PASSWORD || '');
    const token = String(this.env.ZENTAO_TOKEN || creds.ZENTAO_TOKEN || '');
    const url = String(this.env.ZENTAO_URL || this.env.ZENTAO_WEB_URL || '').replace(/\/+$/, '');
    const env = { ...process.env, ZENTAO_URL: url, ZENTAO_ACCOUNT: account };
    if (token) env.ZENTAO_TOKEN = token;
    else env.ZENTAO_PASSWORD = password;
    return execFileAsync('zentao', ['--format=json', '--no-input', '--yes', kind, 'delete', String(id)], { env });
  }
}
