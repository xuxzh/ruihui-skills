// 建反馈单这条写入路径的外部行为：只看脚本对禅道说了什么、Agent 拿到什么。
// 运行：node --test tests/zentao-cli-feedback.mjs
//
// 关注点：
//   - 载荷经文件交给 CLI，正文不进命令行参数；临时文件用完删掉
//   - 建单载荷显式带反馈者（feedbackBy）= 当前禅道账号（禅道不自动记录这个字段）
//   - 提交人核对看创建者字段（openedBy），不是反馈者字段；字段名与实例不一致就如实报
//   - 产品字段用整数形态；来源与模块不填；正文是纯文本描述
//   - 一次调用只发一次创建请求；反馈单不附带建缺陷单
//   - 结果不确定（超时、保存成功但查不到）→ 先查询核实、不重发；认不准就报未确认
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

const DESC_TEXT = [
  '【业务场景】',
  '运维人员在设备管理页导出月度报表。',
  '',
  '【实际结果】',
  '点击导出后没有任何反应，也没有失败提示。',
  '',
  '【预期结果】',
  '应导出 Excel 文件，或给出明确的失败原因。',
].join('\n');

/** 一份能直接交给 CLI 的反馈单载荷（反馈者留给脚本按当前账号补）。 */
function feedbackPayload(overrides = {}) {
  return {
    product: 101,
    title: '设备列表导出按钮点击后无响应',
    type: 'bug',
    desc: DESC_TEXT,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-feedback-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url, ...config }));
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
  return server.state.calls.filter((call) => call.method === 'POST' && call.path === '/api.php/v2/feedbacks');
}

function createdBody(server) {
  const [call] = creates(server);
  return JSON.parse(call.body);
}

function readsOf(server, id) {
  return server.state.calls.filter((call) => call.method === 'GET' && call.path === `/api.php/v2/feedbacks/${id}`);
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

// 这台实例的禅道不自动记录反馈者字段：落库时把 feedbackBy 抹掉（issue #14 的实测行为）
class FeedbacksWithoutFeedbackBy extends Map {
  set(key, value) {
    return super.set(key, { ...value, feedbackBy: '' });
  }
}

// 实例的创建者字段名与预期不一致：回读时 openedBy 根本不在记录里
class FeedbacksWithoutCreatorField extends Map {
  set(key, value) {
    const copy = { ...value };
    delete copy.openedBy;
    return super.set(key, copy);
  }
}

test('F01 建单成功：只发一次创建请求，回读核对通过后交付编号/反馈者/创建者/链接', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'feedback');
    assert.equal(result.id, 900);
    assert.equal(result.title, '设备列表导出按钮点击后无响应');
    assert.equal(result.status, 'active');
    assert.equal(result.product, 101);
    assert.equal(result.openedBy, ACCOUNT);
    assert.equal(result.submitterField, 'openedBy');
    assert.equal(result.submitterIsCurrentAccount, true);
    assert.equal(result.url, `${server.url}/feedback-view-900.html`);
    assert.equal(result.verified, 'readback');

    assert.equal(creates(server).length, 1, '创建请求只能发一次');
    assert.equal(readsOf(server, 900).length, 1, '写入后要按返回的编号回读一次');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');
  });
});

test('F02 建单载荷显式带反馈者 = 当前禅道账号（禅道不自动记录这个字段）', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.equal(body.feedbackBy, ACCOUNT, '反馈者要显式写当前禅道账号');
    assert.equal(singleLineJson(stdout).feedbackBy, ACCOUNT);
  });
});

test('F03 反馈者不让 Agent 手工填别人：载荷里填了别的账号就报错，不建单', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ feedbackBy: 'someone-else' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /反馈者/);
    assert.match(stderr, new RegExp(ACCOUNT));
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 0);
  });
});

test('F04 产品用整数形态：载荷写成字符串时送出去的是数字（字符串形态会被服务端静默忽略）', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ product: '101' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.equal(typeof body.product, 'number', `产品要送数字形态：${JSON.stringify(body.product)}`);
    assert.equal(body.product, 101);
    assert.equal(singleLineJson(stdout).product, 101);
  });
});

test('F05 产品不是数字就报错，不建单', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ product: '演示产品' }));
    const { code, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /product/);
    assert.equal(creates(server).length, 0);
  });
});

test('F06 来源与模块不填：载荷里带了也不发出去', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ source: 'customer', module: '设备管理' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.ok(!('source' in body), `来源不该发出去：${JSON.stringify(body)}`);
    assert.ok(!('module' in body), `模块不该发出去：${JSON.stringify(body)}`);
  });
});

test('F07 正文是纯文本描述：原样送到 desc，不带 HTML 标签', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.equal(body.desc, DESC_TEXT);
    assert.ok(!/<[a-zA-Z/!][^>]*>/.test(body.desc), `正文不该带 HTML：${body.desc}`);
    // 交付输出只给结论与核对依据，正文不进上下文（要看细节用 feedback --id）
  });
});

test('F08 正文写了 HTML 就报错：反馈单的正文是纯文本描述', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ desc: '<p>点击后无响应</p>' }));
    const { code, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /纯文本/);
    assert.equal(creates(server).length, 0);
  });
});

test('F09 提交人核对看创建者字段：反馈者字段为空时仍判定提交人是当前账号', { skip: NEEDS_CLI }, async () => {
  // 这台实例不记录反馈者字段：回读到的记录 feedbackBy 是空的，留痕主体是创建者
  await withMock({ feedbacks: new FeedbacksWithoutFeedbackBy() }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true, '反馈者字段为空不该被判成核对失败');
    assert.equal(result.openedBy, ACCOUNT, '提交人核对看的应是创建者字段');
    assert.equal(result.submitterField, 'openedBy');
    assert.equal(result.submitterIsCurrentAccount, true);
    assert.equal(result.feedbackBy, '', '回读到的反馈者字段如实转出');
    assert.equal(creates(server).length, 1);
  });
});

test('F10 创建者字段名与实例不一致：如实报告，不猜哪个字段是提交人', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new FeedbacksWithoutCreatorField() }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /openedBy/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.created, true);
    assert.deepEqual(result.mismatches, ['创建者字段（openedBy）']);
    assert.equal(creates(server).length, 1, '不重建');
  });
});

test('F11 正文不进命令行参数：载荷经文件、以 --data @<路径> 交给 CLI', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');

    const { code, stderr } = await runScript(['feedback-create', '--payload-file', file], {
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
    assert.ok(createArgv, '应该调起过 feedback create');
    // 正文只经文件过去：--data @<路径>
    assert.equal(createArgv[createArgv.indexOf('--data') + 1], `@${file}`);
    for (const argv of argvList) {
      const joined = argv.join(' ');
      assert.ok(!joined.includes('点击导出后没有任何反应'), `正文不该出现在命令行参数里：${joined}`);
    }
  });
});

test('F12 反馈单不附带建缺陷单：只发反馈创建请求', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const bugCreates = server.state.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api.php/v2/bugs',
    );
    assert.equal(bugCreates.length, 0, '禅道没有反馈转缺陷的关联字段，不该顺带建缺陷单');
    assert.equal(creates(server).length, 1);
  });
});

test('F13 服务端业务失败：如实报错，不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__FAIL__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 1, '失败也不能自动重发');
  });
});

test('F14 回读核对不通过：正文被服务端改写就报不一致，不重建', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__ALTERED_DESC__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /正文/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.id, 900, '单据确实建出来了，编号要交代清楚');
    assert.equal(result.created, true);
    assert.deepEqual(result.mismatches, ['正文']);
    assert.equal(creates(server).length, 1);
  });
});

test('F15 载荷缺必填字段：一个写请求都不发，错误点名缺哪项', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, { title: '只有标题' });
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷缺必填字段：product/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 0);
  });
});

test('F16 没给 --payload-file：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stderr } = await runScript(['feedback-create'], env);
    assert.equal(code, 2);
    assert.match(stderr, /^错误：用法：.*feedback-create --payload-file/);
    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('F17 结果不确定（超时）：不重发，查询核实到唯一一致的新记录后按创建成功交付', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 900);
    assert.equal(result.verified, 'query', '超时后的结论来自查询核实，不是创建回执');
    assert.equal(creates(server).length, 1, '结果不确定也不能重发');
  });
});

test('F18 结果不确定（保存成功但查不到）：报未确认，不把「没查到」说成「没创建」', { skip: NEEDS_CLI }, async () => {
  await withMock({ noopWrites: true }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__NOOP__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runScript(['feedback-create', '--payload-file', file], env);
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
