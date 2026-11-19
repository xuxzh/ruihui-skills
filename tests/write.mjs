// 写入脚本测试：随包的 zentao-write.mjs 在 mock MCP 上的行为。
// 运行：node --test tests/write.mjs
//
// 关注点：
//   - 单据留痕在当前账号名下（禅道 MCP 的 post_users_login 不校验凭据，恒用服务端配置的固定身份）
//   - 写入参数只包一层 payload
//   - 令牌与密码不进输出、不进报错
//   - 凭据无效、载荷不合法、业务失败都要明确失败，不能静默当成功
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-zentao-mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao-write.mjs');
const CRED_VALUE = 'mock-secret-password';

function writeCredentials(dir, { account = 'mock-user', password = CRED_VALUE } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

// 写入脚本是子进程；mock 跑在当前进程里，所以必须用异步的 execFile。
function runWrite(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile('node', [WRITE_SCRIPT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function withMock(fn, overrides = {}) {
  const server = await startMockServer(overrides);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-write-'));
  const credFile = writeCredentials(dir);
  const env = {
    ZENTAO_MCP_URL: server.url,
    ZENTAO_WEB_URL: server.baseUrl,
    ZENTAO_CREDENTIALS_FILE: credFile,
  };
  try {
    await fn({ server, state: server.state, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 写一个载荷文件，返回路径。 */
function writePayload(dir, payload, name = 'payload.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

const BUG_PAYLOAD = {
  productID: 101,
  title: '工序组配置保存路线报数据删除失败',
  openedBuild: ['trunk'],
  severity: 3,
  pri: 3,
  type: 'codeerror',
  steps: '<p><strong>[步骤]</strong></p><p>1. 打开「工序组维护」</p>',
};

test('W01 创建缺陷单：单据留痕在当前账号名下', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, stdout } = await runWrite(['bug-create', '--payload-file', file], { env });
    assert.equal(code, 0);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);
    assert.ok(result.id, '应返回单据 ID');
    const bug = state.bugs.get(String(result.id));
    assert.ok(bug, '单据应落库');
    assert.equal(bug.openedBy, 'mock-user', '提交人应是当前账号');
    assert.notEqual(bug.openedBy, state.serviceAccount, '不应落在服务端固定身份名下');
  });
});

test('W02 写入参数只包一层 payload', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    await runWrite(['bug-create', '--payload-file', file], { env });
    const call = state.calls.find((c) => c.name === 'post_bugs');
    assert.ok(call, '应调用过 post_bugs');
    assert.ok(call.args.payload, '参数必须包在 payload 内');
    assert.equal(call.args.title, undefined, 'payload 外的字段不该出现');
    assert.equal(call.args.payload.productID, 101);
    assert.deepEqual(call.args.payload.openedBuild, ['trunk']);
  });
});

test('W03 令牌与密码不进输出、不进报错', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, BUG_PAYLOAD);
    const { stdout, stderr } = await runWrite(['bug-create', '--payload-file', file], { env });
    assert.ok(!stdout.includes(CRED_VALUE), '输出里不该出现密码');
    assert.ok(!stderr.includes(CRED_VALUE), '报错里不该出现密码');
    for (const token of state.tokens.keys()) {
      assert.ok(!stdout.includes(token), '输出里不该出现令牌');
      assert.ok(!stderr.includes(token), '报错里不该出现令牌');
    }
  });
});

test('W04 凭据无效：明确失败，不写入', async () => {
  await withMock(async ({ state, env, dir }) => {
    const badFile = path.join(dir, 'bad-credentials');
    fs.writeFileSync(badFile, 'ZENTAO_ACCOUNT=mock-user\nZENTAO_PASSWORD=wrong-password\n');
    const file = writePayload(dir, BUG_PAYLOAD);
    const { code, stderr } = await runWrite(['bug-create', '--payload-file', file], {
      env: { ...env, ZENTAO_CREDENTIALS_FILE: badFile },
    });
    assert.notEqual(code, 0, '凭据无效不该当成功');
    assert.match(stderr, /凭据|锁定/);
    assert.equal(state.bugs.size, 0, '不该写入任何单据');
  });
});

test('W05 载荷缺必填字段：写请求之前就失败', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, { productID: 101, title: '缺少影响版本' });
    const { code, stderr } = await runWrite(['bug-create', '--payload-file', file], { env });
    assert.notEqual(code, 0);
    assert.match(stderr, /openedBuild/);
    assert.equal(state.calls.filter((c) => c.name === 'post_bugs').length, 0, '不该发起写入');
  });
});

test('W06 载荷又套了一层 payload：明确报错，不发请求', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, { payload: BUG_PAYLOAD });
    const { code, stderr } = await runWrite(['bug-create', '--payload-file', file], { env });
    assert.notEqual(code, 0);
    assert.match(stderr, /payload/);
    assert.equal(state.calls.filter((c) => c.name === 'post_bugs').length, 0, '不该发起写入');
  });
});

test('W07 业务失败：按失败处理，不当成成功', async () => {
  await withMock(async ({ env, dir }) => {
    const file = writePayload(dir, { ...BUG_PAYLOAD, title: '__FAIL__ 业务失败场景' });
    const { code, stdout } = await runWrite(['bug-create', '--payload-file', file], { env });
    assert.notEqual(code, 0);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, false);
  });
});

test('W08 更新缺陷单：带上单据 ID 与 payload', async () => {
  await withMock(async ({ state, env, dir }) => {
    state.bugs.set('1900', {
      id: 1900, product: 101, title: '旧标题', steps: '<p>旧正文</p>', type: 'codeerror', status: 'active',
      assignedTo: '', openedBy: 'mock-user', severity: 3, pri: 3, openedBuild: ['trunk'], project: 11,
      actions: [{ action: 'opened', actor: 'mock-user', comment: '', date: '2026-03-12 10:22' }],
    });
    const file = writePayload(dir, { productID: 101, title: '旧标题', steps: '<p>旧正文</p><p>补充说明</p>' });
    const { code, stdout } = await runWrite(['bug-update', '--id', '1900', '--payload-file', file], { env });
    assert.equal(code, 0);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);
    assert.equal(result.id, '1900');
    const call = state.calls.find((c) => c.name === 'put_bugs_bugID');
    assert.equal(call.args.bugID, '1900');
    assert.ok(call.args.payload.steps.includes('补充说明'));
  });
});

test('W09 更新缺 ID：明确报错，不发请求', async () => {
  await withMock(async ({ state, env, dir }) => {
    const file = writePayload(dir, { productID: 101, title: '旧标题' });
    const { code, stderr } = await runWrite(['bug-update', '--payload-file', file], { env });
    assert.notEqual(code, 0);
    assert.match(stderr, /--id/);
    assert.equal(state.calls.filter((c) => c.name === 'put_bugs_bugID').length, 0, '不该发起写入');
  });
});
