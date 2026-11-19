// 建缺陷单这条写入路径的外部行为：只看脚本对禅道说了什么、Agent 拿到什么。
// 运行：node --test tests/zentao-cli-bug.mjs
//
// 关注点：
//   - 载荷经文件交给 CLI，正文不进命令行参数；临时文件用完删掉
//   - 一次调用只发一次创建请求（禅道创建没有幂等键）
//   - 写入后按返回编号回读，逐项核对产品、标题、完整正文、影响版本、严重程度、优先级、
//     负责人，以及操作流水里本次新增的「创建」
//   - 结果不确定（超时、保存成功但查不到）→ 先查询核实、不重发；认不准就报未确认
//   - 负责人按「终端用户明说 > 本机默认 > 随包默认 > 代码兜底（产品 QD）」解析
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS, createMockApiState, startMockApi } from './mock-zentao-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao.mjs');
const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本靠官方禅道 CLI 取数写数；没装就别假装测过
function findCli() {
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

const ZENTAO_CLI = findCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

// 替身 CLI：把收到的命令行参数记下来，再原样交给真的禅道 CLI。
// 这样能直接看到「脚本对 CLI 说了什么」，而不必猜脚本内部怎么拼参数。
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

const BODY_HTML = [
  '<p><strong>[步骤]</strong></p>',
  '<p>1. 打开「设备管理」</p>',
  '<p>2. 选择时间范围后点「导出」</p>',
  '<p><strong>[实际结果]</strong></p>',
  '<p>点击后无响应，控制台报 500。</p>',
].join('');

/** 一份能直接交给 CLI 的缺陷单载荷（负责人留给脚本按配置补）。 */
function bugPayload(overrides = {}) {
  return {
    productID: 101,
    title: '设备列表导出按钮点击后无响应',
    openedBuild: ['trunk'],
    severity: 3,
    pri: 3,
    type: 'codeerror',
    steps: BODY_HTML,
    ...overrides,
  };
}

function writePayload(dir, payload) {
  const file = path.join(dir, `payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function writeCredentials(dir) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${ACCOUNT}\nZENTAO_PASSWORD=${PASSWORD}\n`);
  return file;
}

// 入口脚本是子进程；假服务跑在当前进程里，所以必须用异步 execFile——
// 同步等待会卡住当前进程的事件循环，假服务就没人应答了。
function runScript(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/**
 * 起假服务 + 隔离的本机配置：
 *   credentials（凭据）、preferences.json（本机偏好）、config.local.json（随包默认）
 * 三份文件都落在临时目录里，测试不碰开发者本机的真实配置。
 */
async function withMock({ config = {}, preferences = {}, ...overrides }, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-bug-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url, bugAssignee: '', ...config }));
  const preferencesFile = path.join(dir, 'preferences.json');
  fs.writeFileSync(preferencesFile, JSON.stringify(preferences));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: writeCredentials(dir),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
    ZENTAO_PREFERENCES_FILE: preferencesFile,
  };
  try {
    await fn({ server, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假服务收到的创建请求（禅道一次创建就是一条记录，所以这个数量就是「发了几次」）。 */
function creates(server) {
  return server.state.calls.filter((call) => call.method === 'POST' && call.path === '/api.php/v2/bugs');
}

function createdBody(server) {
  const [call] = creates(server);
  return JSON.parse(call.body);
}

function readsOf(server, id) {
  return server.state.calls.filter((call) => call.method === 'GET' && call.path === `/api.php/v2/bugs/${id}`);
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

test('B01 建单成功：只发一次创建请求，回读核对通过后交付编号/状态/负责人来源/提交人/链接', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload());
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'bug');
    assert.equal(result.id, 1900);
    assert.equal(result.title, '设备列表导出按钮点击后无响应');
    assert.equal(result.status, 'active');
    assert.equal(result.assignedTo, '');
    assert.equal(result.assigneeSource, 'package');
    assert.equal(result.openedBy, ACCOUNT);
    assert.equal(result.url, `${server.url}/bug-view-1900.html`);
    assert.equal(result.verified, 'readback');

    assert.equal(creates(server).length, 1, '创建请求只能发一次');
    assert.equal(readsOf(server, 1900).length, 1, '写入后要按返回的编号回读一次');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');
  });
});

test('B02 正文不进命令行参数：载荷经文件、以 --data @<路径> 交给 CLI', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const file = writePayload(dir, bugPayload());
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');

    const { code, stderr } = await runScript(['bug-create', '--payload-file', file], {
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RH_CLI_SHIM_LOG: argvLog,
      RH_CLI_REAL: ZENTAO_CLI,
    });
    assert.equal(code, 0, stderr);

    const argvList = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const createArgv = argvList.find((argv) => argv.includes('create'));
    assert.ok(createArgv, '应该调起过 bug create');
    // 正文只经文件过去：--data @<路径>
    assert.equal(createArgv[createArgv.indexOf('--data') + 1], `@${file}`);
    for (const argv of argvList) {
      const joined = argv.join(' ');
      assert.ok(!joined.includes('[步骤]'), `正文不该出现在命令行参数里：${joined}`);
      assert.ok(!joined.includes('控制台报 500'), `正文不该出现在命令行参数里：${joined}`);
    }
  });
});

test('B03 服务端业务失败：如实报错，不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ title: '__FAIL__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 1, '失败也不能自动重发');
  });
});

test('B04 回读核对不通过：正文被服务端改写就报不一致，不重建', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ title: '__ALTERED_DESC__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /正文/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.id, 1900, '单据确实建出来了，编号要交代清楚');
    assert.equal(result.created, true);
    assert.deepEqual(result.mismatches, ['正文']);
    assert.equal(creates(server).length, 1);
  });
});

test('B05 回读核对流水：没有本次新增的「创建」就不算建成功', { skip: NEEDS_CLI }, async () => {
  // 服务端返回成功但没落库，回读到的是提前放好的同内容记录——只差 actions 里没有 opened
  const stored = {
    id: 1900,
    title: '设备列表导出按钮点击后无响应',
    status: 'active',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: '',
    product: 101,
    steps: BODY_HTML,
    severity: '3',
    pri: '3',
    type: 'codeerror',
    openedBuild: ['trunk'],
    project: 0,
    execution: 0,
    actions: [],
  };
  await withMock({ noopWrites: true, bugs: new Map([[1900, stored]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload());
    const { code, stdout } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 1);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ['操作流水里本次新增的「创建」']);
    assert.equal(creates(server).length, 1, '不重发');
  });
});

test('B06 负责人：终端用户明说优先，载荷照原样送出去', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ assignedTo: 'majiawei' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assigneeSource, 'user');
    assert.equal(result.assignedTo, 'majiawei');
    assert.equal(createdBody(server).assignedTo, 'majiawei');
  });
});

test('B07 负责人：本机默认盖过随包默认', { skip: NEEDS_CLI }, async () => {
  await withMock({ config: { bugAssignee: '' }, preferences: { bugAssignee: 'zhangsan' } }, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload());
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assigneeSource, 'local');
    assert.equal(result.assignedTo, 'zhangsan');
    assert.equal(createdBody(server).assignedTo, 'zhangsan');
  });
});

test('B08 负责人：随包默认是不指派，载荷显式带空串挡住禅道默认指派', { skip: NEEDS_CLI }, async () => {
  await withMock({ config: { bugAssignee: '' }, preferences: {} }, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload());
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assigneeSource, 'package');
    assert.equal(result.assignedTo, '');
    const body = createdBody(server);
    assert.ok('assignedTo' in body, '不指派也要把字段显式发过去');
    assert.equal(body.assignedTo, '');
  });
});

test('B09 负责人：代码兜底是产品 QD，载荷不带 assignedTo 由禅道按产品指派', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: {} }, async ({ server, env, dir }) => {
    // 随包配置里没有 bugAssignee → 落到代码兜底 "qd"
    const packageConfig = path.join(dir, 'config.local.json');
    fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url }));
    const file = writePayload(dir, bugPayload());
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assigneeSource, 'qd');
    const body = createdBody(server);
    assert.ok(!('assignedTo' in body), '交给产品 QD 时不该带 assignedTo');
    // 回读到的负责人就是禅道侧指派的结果（产品的 QD），照实转出
    assert.equal(result.assignedTo, 'mock-qd');
  });
});

test('B10 载荷缺必填字段：一个写请求都不发，错误点名缺哪项', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, { title: '只有标题' });
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷缺必填字段：productID、openedBuild/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 0);
  });
});

test('B11 没给 --payload-file：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stderr } = await runScript(['bug-create'], env);
    assert.equal(code, 2);
    assert.match(stderr, /^错误：用法：.*bug-create --payload-file/);
    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('B12 结果不确定（超时）：不重发，查询核实到唯一一致的新记录后按创建成功交付', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 1900);
    assert.equal(result.verified, 'query', '超时后的结论来自查询核实，不是创建回执');
    assert.equal(creates(server).length, 1, '结果不确定也不能重发');
  });
});

test('B13 结果不确定（保存成功但查不到）：报未确认，不把「没查到」说成「没创建」', { skip: NEEDS_CLI }, async () => {
  await withMock({ noopWrites: true }, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ title: '__NOOP__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 1);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.candidates, []);
    assert.match(stderr, /未确认/);
    assert.ok(!/没创建/.test(`${stderr}${stdout}`), '不能把「没查到」说成「没创建」');
    assert.equal(creates(server).length, 1, '不重发');
  });
});

// 已经有 25 条缺陷的产品：基线扫描超过一页（假服务每页 20 条）
function manyBugs(count) {
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const id = 1800 + i;
    map.set(id, {
      id,
      product: 101,
      title: `历史缺陷 ${i + 1}`,
      status: 'active',
      openedBy: ACCOUNT,
      openedDate: '2026-11-01 10:00:00',
      assignedTo: '',
      severity: '3',
      pri: '3',
      type: 'codeerror',
      openedBuild: ['trunk'],
      steps: '<p>历史正文</p>',
      actions: [{ id: id * 10, action: 'opened', actor: ACCOUNT, date: '2026-11-01 10:00:00', comment: '' }],
    });
  }
  return map;
}

test('B14 查重基线不完整（服务端分页不前进）：建单后只能报「是否新建未确认」，不判成功、不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: manyBugs(25), pagingStuckProducts: [101] }, async ({ server, env, dir }) => {
    const file = writePayload(dir, bugPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
    assert.equal(code, 1);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false, '基线不完整时不能凭「基线之外唯一」判成功');
    assert.equal(result.uncertain, true);
    assert.equal(result.baselineComplete, false);
    assert.match(stderr, /查重基线不完整/);
    assert.match(stderr, /未确认/);
    assert.ok(!/没创建/.test(`${stderr}${stdout}`), '不能把「没查到」说成「没创建」');
    assert.equal(creates(server).length, 1, '不重发');
  });
});

test('B15 基线里混进别的产品的记录：同样只报「是否新建未确认」，不判成功、不重发', { skip: NEEDS_CLI }, async () => {
  // 请求产品 101 的缺陷列表，服务端回的是产品 102 的记录（复刻真实实例的怪象）
  await withMock(
    {
      bugs: new Map([
        [1900, { id: 1900, product: 102, title: '别的产品的缺陷', status: 'active', openedBy: ACCOUNT, assignedTo: '', steps: '<p>正文</p>', severity: '3', pri: '3', type: 'codeerror', openedBuild: ['trunk'], actions: [] }],
      ]),
      foreignProductLists: { 101: 102 },
    },
    async ({ server, env, dir }) => {
      const file = writePayload(dir, bugPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
      const { code, stdout, stderr } = await runScript(['bug-create', '--payload-file', file], env);
      assert.equal(code, 1);

      const result = singleLineJson(stdout);
      assert.equal(result.ok, false, '基线里的记录不属于本产品时不能判成功');
      assert.equal(result.uncertain, true);
      assert.equal(result.baselineComplete, false);
      assert.match(stderr, /不属于产品 101，已丢弃/);
      assert.equal(creates(server).length, 1, '不重发');
    },
  );
});
