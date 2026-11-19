// 写入路径测试：入口脚本（scripts/zentao.mjs）的写子命令在假禅道 API v2 服务上的行为。
// 运行：node --test tests/write.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 单据留痕在当前账号名下（令牌经环境变量注入 CLI 进程，权限就是当前账号的）
//   - 载荷只包一层、正文只走载荷文件；一次调用只发一次创建请求
//   - 缺陷单的负责人：缺省跟产品 QD 走或按配置改，终端用户明说的优先
//   - 令牌与密码不进输出、不进报错
//   - 凭据无效、载荷不合法、业务失败都要明确失败，不能静默当成功
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MOCK_API_ACCOUNT,
  MOCK_API_ACCOUNTS,
  createMockApiState,
  startMockApi,
} from './mock-zentao-api.mjs';
import { ZentaoEntry, findZentaoCli } from './zentao-client.mjs';

const ZENTAO_CLI = findZentaoCli();
// 入口脚本靠官方禅道 CLI 写数；没装就别假装测过
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

const ACCOUNT = MOCK_API_ACCOUNT;
const CRED_VALUE = MOCK_API_ACCOUNTS[ACCOUNT];

// 替身 CLI：把收到的命令行参数记下来，再原样交给真的禅道 CLI。
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

const BUG_PAYLOAD = {
  productID: 101,
  title: '工序组配置保存路线报数据删除失败',
  openedBuild: ['trunk'],
  severity: 3,
  pri: 3,
  type: 'codeerror',
  steps: '<p><strong>[步骤]</strong></p><p>1. 打开「工序组维护」</p>',
};

/** 载荷文件：入口脚本把它交给 CLI，读完自己删掉，所以每次写一份新的。 */
function writePayload(dir, payload, name = `payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function writeCredentials(dir, { account = ACCOUNT, password = CRED_VALUE } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

/**
 * 起假服务 + 隔离的本机配置：
 *   credentials（凭据）、preferences.json（本机偏好）、config.local.json（随包默认）
 * 三份文件都落在临时目录里，测试不碰开发者本机的真实配置。
 */
async function withMock({ config = { bugAssignee: 'qd' }, preferences = {}, credentials = true, ...overrides }, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-write-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url, ...config }));
  const preferencesFile = path.join(dir, 'preferences.json');
  fs.writeFileSync(preferencesFile, JSON.stringify(preferences));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: credentials ? writeCredentials(dir) : path.join(dir, 'missing'),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
    ZENTAO_PREFERENCES_FILE: preferencesFile,
  };
  const zentao = new ZentaoEntry({ env });
  try {
    await fn({ zentao, server, state: server.state, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假服务收到的写请求：数量就是「发了几次」。 */
function writes(state, kind) {
  return state.calls.filter((c) => c.method === 'POST' && c.path === `/api.php/v2/${kind}s`);
}

function createdBody(state, kind = 'bug') {
  const [call] = writes(state, kind);
  return JSON.parse(call.body);
}

test('W01 创建缺陷单：单据留痕在当前账号名下', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data, stderr } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0, stderr);
    assert.equal(data.ok, true);
    assert.ok(data.id, '应返回单据 ID');
    const bug = state.bugs.get(Number(data.id));
    assert.ok(bug, '单据应落库');
    assert.equal(bug.openedBy, ACCOUNT, '提交人应是当前账号');
  });
});

test('W02 载荷只包一层、正文只走文件：命令行参数里没有正文', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ state, env, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');
    const shimmed = new ZentaoEntry({
      env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RH_CLI_SHIM_LOG: argvLog, RH_CLI_REAL: ZENTAO_CLI },
    });

    const { code, stderr } = await shimmed.run(['bug-create', '--payload-file', file]);
    assert.equal(code, 0, stderr);

    const argvList = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const argv of argvList) {
      assert.ok(!argv.join(' ').includes('[步骤]'), '正文不该出现在命令行参数里');
    }

    // 服务端收到的请求体只包一层：字段直接在请求体里
    const body = createdBody(state);
    assert.equal(body.productID, 101);
    assert.deepEqual(body.openedBuild, ['trunk']);
    assert.equal(body.payload, undefined, '不该再套一层 payload');
  });
});

test('W03 令牌与密码不进输出、不进报错', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const res = await zentao.run(['bug-create', '--payload-file', file]);
    const printed = `${res.stdout}${res.stderr}`;
    assert.ok(!printed.includes(CRED_VALUE), '输出里不该出现密码');
    for (const token of state.tokens.keys()) {
      assert.ok(!printed.includes(token), '输出里不该出现令牌');
    }
  });
});

test('W04 凭据无效：明确失败，不写入', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const badFile = path.join(dir, 'bad-credentials');
    fs.writeFileSync(badFile, `ZENTAO_ACCOUNT=${ACCOUNT}\nZENTAO_PASSWORD=wrong-password\n`);
    const bad = new ZentaoEntry({ env: { ...zentao.env, ZENTAO_CREDENTIALS_FILE: badFile } });
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, stderr } = await bad.run(['bug-create', '--payload-file', file]);
    assert.notEqual(code, 0, '凭据无效不该当成功');
    assert.match(stderr, /凭据|锁定/);
    assert.equal(state.bugs.size, 0, '不该写入任何单据');
  });
});

test('W05 载荷缺必填字段：写请求之前就失败', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, { productID: 101, title: '缺少影响版本' });
    const { code, stderr } = await zentao.run(['bug-create', '--payload-file', file]);
    assert.notEqual(code, 0);
    assert.match(stderr, /openedBuild/);
    assert.equal(writes(state, 'bug').length, 0, '不该发起写入');
  });
});

test('W06 载荷又套了一层 payload：明确报错，不发请求', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, { payload: BUG_PAYLOAD });
    const { code, stderr } = await zentao.run(['bug-create', '--payload-file', file]);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷缺必填字段/);
    assert.equal(writes(state, 'bug').length, 0, '不该发起写入');
  });
});

test('W07 业务失败：按失败处理，不当成成功', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, dir }) => {
    const file = writePayload(dir, { ...BUG_PAYLOAD, title: '__FAIL__ 业务失败场景' });
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.notEqual(code, 0);
    assert.equal(data.ok, false);
  });
});

test('W08 更新缺陷单：带上单据 ID 与请求体，正文原样送达', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    state.bugs.set(1900, {
      id: 1900, product: 101, title: '旧标题', steps: '<p>旧正文</p>', type: 'codeerror', status: 'active',
      assignedTo: '', openedBy: ACCOUNT, severity: '3', pri: '3', openedBuild: ['trunk'], project: 11, execution: 0,
      actions: [{ id: 19000, action: 'opened', actor: ACCOUNT, date: '2026-03-12 10:22', comment: '' }],
    });
    const file = writePayload(dir, { steps: '旧正文\n\n──────────────\n【补充说明 · 2026-03-12 · 用户口述，AI 整理】\n补充说明', expectedBody: '旧正文' });
    const { code, data, stderr } = await zentao.json(['bug-update', '--id', '1900', '--payload-file', file]);
    assert.equal(code, 0, stderr);
    assert.equal(data.ok, true);
    assert.equal(data.id, 1900);
    const put = state.calls.find((c) => c.method === 'PUT' && c.path === '/api.php/v2/bugs/1900');
    assert.ok(put, '应更新 #1900');
    assert.match(JSON.parse(put.body).steps, /补充说明/);
  });
});

test('W09 更新缺 ID：明确报错，不发请求', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, { steps: '旧正文', expectedBody: '旧正文' });
    const { code, stderr } = await zentao.run(['bug-update', '--payload-file', file]);
    assert.notEqual(code, 0);
    assert.match(stderr, /--id/);
    assert.equal(state.calls.filter((c) => c.method === 'PUT').length, 0, '不该发起写入');
  });
});

test('W10 缺省负责人 = 产品 QD：载荷不带 assignedTo，由禅道按产品 QD 指派', { skip: NEEDS_CLI }, async () => {
  // 随包配置里没有 bugAssignee → 落到代码兜底 "qd"
  await withMock({ config: {}, preferences: {} }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data, stderr } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0, stderr);
    const body = createdBody(state);
    assert.equal('assignedTo' in body, false, '缺省不写这个字段');
    assert.equal(data.assigneeSource, 'qd');
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, 'mock-qd', '缺省按产品 QD 指派');
  });
});

test('W11 两层都没配：同样按产品 QD 指派', { skip: NEEDS_CLI }, async () => {
  await withMock({ config: {}, preferences: {} }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    const body = createdBody(state);
    assert.equal('assignedTo' in body, false);
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, 'mock-qd');
  });
});

test('W12 本机默认负责人配成空串：不指派，挡住产品 QD', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: { bugAssignee: '' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal(createdBody(state).assignedTo, '', '载荷要带空字符串');
    const bug = state.bugs.get(Number(data.id));
    assert.equal(bug.assignedTo, '', '不该被指派');
    assert.ok(!bug.actions.some((a) => a.action === 'assigned'), '不应多出一条指派流水');
  });
});

test('W13 本机默认负责人配成 qd：按产品 QD 指派', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: { bugAssignee: 'qd' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal('assignedTo' in createdBody(state), false);
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, 'mock-qd');
  });
});

test('W14 本机默认负责人配成账号：按配置指给该账号', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: { bugAssignee: 'zhangsan' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal(createdBody(state).assignedTo, 'zhangsan');
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, 'zhangsan');
  });
});

test('W15 终端用户明说不指派：盖过 qd 配置', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: { bugAssignee: 'qd' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, { ...BUG_PAYLOAD, assignedTo: '' });
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, '', '用户明说的不指派优先于配置');
  });
});

test('W16 终端用户指名负责人：盖过配置', { skip: NEEDS_CLI }, async () => {
  await withMock({ preferences: { bugAssignee: 'qd' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, { ...BUG_PAYLOAD, assignedTo: 'lisi' });
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, 'lisi');
  });
});

test('W17 本机默认负责人盖过随包默认负责人', { skip: NEEDS_CLI }, async () => {
  await withMock({ config: { bugAssignee: 'qd' }, preferences: { bugAssignee: '' } }, async ({ zentao, state, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, data } = await zentao.json(['bug-create', '--payload-file', file]);
    assert.equal(code, 0);
    assert.equal(createdBody(state).assignedTo, '', '本机设置优先');
    assert.equal(state.bugs.get(Number(data.id)).assignedTo, '');
  });
});
