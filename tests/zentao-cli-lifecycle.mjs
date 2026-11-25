// 入口脚本（scripts/zentao.mjs）的生命周期流转、字段编辑与批量操作在假禅道 API v2 服务上的行为。
// 运行：node --test tests/zentao-cli-lifecycle.mjs
//
// 关注点（ADR-0024）：所有流转与编辑都经脚本护栏——前置格式校验、状态预检、写前 CAS 复核、
// 只发一次写入、写后回读核对；批量先预检再串行执行、分三栏汇报且不自动重试；物理删除不开放。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_ACCOUNT } from './mock-zentao-api.mjs';
import { findZentaoCli, installCliShim, runEntryScript, withMockApi } from './zentao-client.mjs';

const ACCOUNT = MOCK_API_ACCOUNT;
const ZENTAO_CLI = findZentaoCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

const withMock = (opts, fn) => withMockApi({ tag: 'rh-cli-lifecycle', config: {}, preferences: {}, ...opts }, fn);

function seedBug(overrides = {}) {
  return {
    id: 1900,
    product: 101,
    title: '设备列表导出按钮点击后无响应',
    status: 'active',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: 'dev-a',
    steps: '<p>【实际结果】</p><p>导出无响应</p>',
    severity: '3',
    pri: '3',
    type: 'codeerror',
    openedBuild: ['trunk'],
    project: 11,
    execution: 0,
    story: 0,
    resolvedBy: '',
    resolvedDate: '',
    resolvedBuild: '',
    resolution: '',
    closedBy: '',
    closedDate: '',
    activatedCount: 0,
    actions: [{ id: 19000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
    ...overrides,
  };
}

function seedFeedback(overrides = {}) {
  return {
    id: 900,
    product: 101,
    module: 0,
    title: '希望支持批量导出 Excel',
    status: 'wait',
    type: 'story',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: '',
    feedbackBy: ACCOUNT,
    desc: '现在只能一页页复制。',
    closedReason: '',
    closedBy: '',
    closedDate: '',
    actions: [{ id: 9000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
    ...overrides,
  };
}

function writePayload(dir, payload) {
  const file = path.join(dir, `payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

/** 假服务收到的某种方法 + 路径后缀的请求（写入次数 = 「发了几次」）。 */
function writesOf(server, method, suffix) {
  return server.state.calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

// 丢响应的替身 CLI：带指定动作名的请求照发（服务端会落库），但把响应丢掉，模拟「结果不明」。
const LOSSY_SHIM = (actionName) => `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(argv) + '\\n');
if (argv.includes('${actionName}')) {
  execFileSync(process.env.RH_CLI_REAL, argv, { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
  process.stdout.write('{ 这不是合法 JSON');
  process.exit(0);
}
execFileSync(process.env.RH_CLI_REAL, argv, { stdio: 'inherit', env: process.env });
`;

// ---------------------------------------------------------------- 解决缺陷

test('R01 解决缺陷：校验通过 → 写入一次 → 回读状态/结论/日期一致，流水新增 resolved', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-resolve', '--id', '1900', '--resolution', 'fixed', '--comment', '已修复'],
      env,
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'resolve');
    assert.equal(result.id, 1900);
    assert.equal(result.status, 'resolved');
    assert.equal(result.resolution, 'fixed');
    assert.deepEqual(result.newActions, ['resolved']);
    assert.equal(result.verified, 'readback');
    assert.match(result.url, /bug-view-1900\.html$/);

    assert.equal(writesOf(server, 'PUT', '/bugs/1900/resolve').length, 1, '只发一次');
    const stored = server.state.bugs.get(1900);
    assert.equal(stored.status, 'resolved');
    assert.equal(stored.resolution, 'fixed');
  });
});

test('R02 解决缺陷：resolution 非法枚举在本地被拦下，一个写请求都不发', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'wontfix-typo'], env);
    assert.equal(code, 1);
    assert.match(stderr, /resolution 必须是以下之一/);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0);
  });
});

test('R03 解决缺陷：缺 resolution 报错，不查禅道也不写入', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['bug-resolve', '--id', '1900'], env);
    assert.equal(code, 1);
    assert.match(stderr, /缺必填字段：resolution/);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0);
  });
});

test('R04 解决缺陷：resolvedDate 格式不对在本地被拦下', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(
      ['bug-resolve', '--id', '1900', '--resolution', 'fixed', '--resolved-date', '2026/11/25'],
      env,
    );
    assert.equal(code, 1);
    assert.match(stderr, /YYYY-MM-DD/);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0);
  });
});

test('R05 解决缺陷：已 resolved 的缺陷被预检拦下（幂等冗余），不发写请求', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug({ status: 'resolved', resolution: 'fixed' })]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed'], env);
    assert.equal(code, 1);
    assert.match(stderr, /当前已是 resolved 状态/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0);
  });
});

test('R06 解决缺陷：closed 的缺陷不能直接解决，预检拦下并提示先激活', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug({ status: 'closed' })]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed'], env);
    assert.equal(code, 1);
    assert.match(stderr, /closed 状态，不能直接解决/);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0);
  });
});

test('R07 解决缺陷：resolution=duplicate 且备注里没有单号时给出 warning，但仍照常写入', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'duplicate'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /duplicate/.test(w) && /单号/.test(w)));
  });
});

test('R08 解决缺陷：服务端拒绝时如实报错，不重发', { skip: NEEDS_CLI }, async () => {
  // 假服务对 active 缺陷放行 resolve；这里用不存在的产品权限之外的方式触发业务失败：不存在的产品
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    server.state.failPaths.push('/api.php/v2/bugs/1900/resolve');
    const { code, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 1, '失败也不自动重试');
  });
});

// ---------------------------------------------------------------- 关闭 / 激活缺陷

test('R09 关闭缺陷：resolved → closed，回读状态与 closedBy/closedDate 一致', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug({ status: 'resolved', resolution: 'fixed' })]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-close', '--id', '1900', '--comment', '验证通过'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.status, 'closed');
    assert.deepEqual(result.newActions, ['closed']);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900/close').length, 1);
  });
});

test('R10 关闭缺陷：active 状态带 warning（多数工作流需先解决），服务端拒绝时附下一步提示', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env }) => {
    const preview = await runEntryScript(['bug-close', '--id', '1900', '--preview'], env);
    assert.equal(preview.code, 0, preview.stderr);
    const previewResult = singleLineJson(preview.stdout);
    assert.equal(previewResult.preview, true);
    assert.equal(previewResult.executable.length, 1);
    assert.match(previewResult.executable[0].warning, /先 bug-resolve 再关闭/);

    const { code, stderr } = await runEntryScript(['bug-close', '--id', '1900'], env);
    assert.equal(code, 1);
    assert.match(stderr, /先执行 bug-resolve 再执行 bug-close/);
  });
});

test('R11 关闭缺陷：已 closed 的被预检拦下，不发写请求', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug({ status: 'closed' })]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['bug-close', '--id', '1900'], env);
    assert.equal(code, 1);
    assert.match(stderr, /无需重复关闭/);
    assert.equal(writesOf(server, 'PUT', '/close').length, 0);
  });
});

test('R12 激活缺陷：closed → active，可同时改派与改影响版本', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug({ status: 'closed', assignedTo: '' })]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-activate', '--id', '1900', '--assigned-to', 'dev-b', '--opened-build', 'trunk', '--comment', '又复现了'],
      env,
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.status, 'active');
    assert.equal(result.assignedTo, 'dev-b');
    assert.deepEqual(result.openedBuild, ['trunk']);
    assert.deepEqual(result.newActions, ['activated']);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900/activate').length, 1);
  });
});

test('R13 激活缺陷：active 的被预检拦下，不发写请求', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['bug-activate', '--id', '1900'], env);
    assert.equal(code, 1);
    assert.match(stderr, /无需重复激活/);
    assert.equal(writesOf(server, 'PUT', '/activate').length, 0);
  });
});

// ---------------------------------------------------------------- 关闭 / 激活反馈

test('R14 关闭反馈：必须给合法 closedReason，缺了或非法都在本地拦下', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env }) => {
    const missing = await runEntryScript(['feedback-close', '--id', '900'], env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /缺必填字段：closedReason/);

    const bad = await runEntryScript(['feedback-close', '--id', '900', '--closed-reason', 'done'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /closedReason 必须是以下之一/);
    assert.equal(writesOf(server, 'PUT', '/close').length, 0);
  });
});

test('R15 关闭反馈：closedReason=refuse 正常关闭并回读一致', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(
      ['feedback-close', '--id', '900', '--closed-reason', 'refuse', '--comment', '与本季度方向不符'],
      env,
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.status, 'closed');
    assert.equal(result.closedReason, 'refuse');
    assert.deepEqual(result.newActions, ['closed']);
    assert.equal(writesOf(server, 'PUT', '/feedbacks/900/close').length, 1);
  });
});

test('R16 关闭反馈：confirmClose 只接受 true / 1 / yes / true 字符串', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env }) => {
    const bad = await runEntryScript(['feedback-close', '--id', '900', '--closed-reason', 'commented', '--confirm-close', 'maybe'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /confirmClose/);
    assert.equal(writesOf(server, 'PUT', '/close').length, 0);

    const ok = await runEntryScript(['feedback-close', '--id', '900', '--closed-reason', 'commented', '--confirm-close', '1'], env);
    assert.equal(ok.code, 0, ok.stderr);
  });
});

test('R17 激活反馈：closed → 激活后不再是 closed；未关闭的被预检拦下', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback({ status: 'closed', closedReason: 'refuse' })]]) }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['feedback-activate', '--id', '900', '--assigned-to', 'dev-c'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.notEqual(result.status, 'closed');
    assert.equal(result.assignedTo, 'dev-c');
    assert.deepEqual(result.newActions, ['activated']);
  });
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['feedback-activate', '--id', '900'], env);
    assert.equal(code, 1);
    assert.match(stderr, /未关闭）.*无需激活/);
    assert.equal(writesOf(server, 'PUT', '/activate').length, 0);
  });
});

// ---------------------------------------------------------------- 编辑模式（单条）

test('E01 编辑缺陷：命令行直传字段（改派 + 调优先级），CLI autoFill 补齐其余字段，回读一致', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-update', '--id', '1900', '--assigned-to', 'dev-b', '--pri', '1'],
      env,
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'edit');
    assert.equal(result.assignedTo, 'dev-b');
    // 同时改了负责人与优先级，禅道记的是「编辑」流水
    assert.deepEqual(result.newActions, ['edited']);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900').length, 1);
    const put = writesOf(server, 'PUT', '/bugs/1900')[0];
    const body = JSON.parse(put.body);
    assert.equal(body.assignedTo, 'dev-b');
    assert.equal(body.pri, 1);
    assert.equal(body.title, '设备列表导出按钮点击后无响应', 'autoFill 应带原标题，避免 PUT 覆盖为空');
    assert.equal(body.steps, '<p>【实际结果】</p><p>导出无响应</p>', 'autoFill 应带原正文');
  });
});

test('E01b 只改派负责人：禅道记的是「指派」流水，回读核对接受 edited / assigned 任一', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--assigned-to', 'dev-b'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assignedTo, 'dev-b');
    assert.deepEqual(result.newActions, ['assigned']);
  });
});

test('E01c 只改派反馈单的 type 等其它字段：流水是 edited，不会误判为 assigned', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ env }) => {
    const { code, stdout } = await runEntryScript(['feedback-update', '--id', '900', '--type', 'advice'], env);
    assert.equal(code, 0);
    assert.deepEqual(singleLineJson(stdout).newActions, ['edited']);
  });
});

test('E02 编辑缺陷：取消指派（--assigned-to ""）生效', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--assigned-to', ''], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.assignedTo, '');
  });
});

test('E03 编辑缺陷：非法枚举与越界数字在本地拦下', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const badType = await runEntryScript(['bug-update', '--id', '1900', '--type', 'not-a-type'], env);
    assert.equal(badType.code, 1);
    assert.match(badType.stderr, /bug type 必须是以下之一/);

    const badPri = await runEntryScript(['bug-update', '--id', '1900', '--pri', '9'], env);
    assert.equal(badPri.code, 1);
    assert.match(badPri.stderr, /pri 要写 1 到 4 的整数/);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900').length, 0);
  });
});

test('E04 编辑缺陷：改写正文必须带 expectedBody；当前正文与它不一致时停手不写', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const noExpect = writePayload(dir, { mode: 'edit', steps: '<p>新正文</p>' });
    const r1 = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', noExpect], env);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /必须带 expectedBody/);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900').length, 0);

    const stale = writePayload(dir, { mode: 'edit', steps: '<p>新正文</p>', expectedBody: '<p>别人改过的正文</p>' });
    const r2 = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', stale], env);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /被改过/);
    const conflict = singleLineJson(r2.stdout);
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.changed, ['正文']);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900').length, 0, 'CAS 没过就不许写');
  });
});

test('E05 编辑缺陷：改写正文（CAS 通过）→ 回读正文逐字一致，原文其它字段保留', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      mode: 'edit',
      steps: '<p>【实际结果】</p><p>导出无响应，控制台报 500</p>',
      expectedBody: '【实际结果】\n导出无响应',
    });
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.mode, 'edit');
    assert.equal(result.verified, 'readback');
    const stored = server.state.bugs.get(1900);
    assert.equal(stored.steps, '<p>【实际结果】</p><p>导出无响应，控制台报 500</p>');
    assert.equal(stored.assignedTo, 'dev-a', '未请求修改的字段必须保留');
    assert.equal(stored.pri, '3');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');
  });
});

test('E06 编辑缺陷：改标题必须带 expectedTitle，冲突时停手', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const noExpect = writePayload(dir, { mode: 'edit', title: '新标题' });
    const r1 = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', noExpect], env);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /必须带 expectedTitle/);

    const stale = writePayload(dir, { mode: 'edit', title: '新标题', expectedTitle: '别人改过的标题' });
    const r2 = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', stale], env);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /被改过/);
    assert.deepEqual(singleLineJson(r2.stdout).changed, ['标题']);
    assert.equal(writesOf(server, 'PUT', '/bugs/1900').length, 0);
  });
});

test('E07 编辑反馈：改 type；assignedTo 被拒绝并指到 feedback-activate', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env }) => {
    const ok = await runEntryScript(['feedback-update', '--id', '900', '--type', 'advice'], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(singleLineJson(ok.stdout).ok, true);
    const put = writesOf(server, 'PUT', '/feedbacks/900')[0];
    const body = JSON.parse(put.body);
    assert.equal(body.type, 'advice');
    assert.equal(body.product, 101, 'autoFill 应带原产品');
    assert.equal(body.title, '希望支持批量导出 Excel', 'autoFill 应带原标题');
  });
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, { mode: 'edit', assignedTo: 'dev-c' });
    const { code, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /不支持修改 assignedTo.*feedback-activate/);
  });
});

test('E08 编辑反馈：--payload-file 与命令行同字段值冲突时报冲突，不写入', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, { type: 'bug' });
    const { code, stderr } = await runEntryScript(
      ['feedback-update', '--id', '900', '--payload-file', file, '--type', 'advice'],
      env,
    );
    assert.equal(code, 1);
    assert.match(stderr, /参数冲突/);
    assert.equal(writesOf(server, 'PUT', '/feedbacks/900').length, 0);
  });
});

test('E09 编辑反馈：desc 改写不允许 HTML，且必须带 expectedBody', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ env, dir }) => {
    const html = writePayload(dir, { mode: 'edit', desc: '<p>新正文</p>', expectedBody: '现在只能一页页复制。' });
    const r1 = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', html], env);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /纯文本/);
  });
});

test('E10 编辑：载荷里没有可更新字段时报错', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, { mode: 'edit' });
    const { code, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /没有可更新的字段/);
  });
});

test('E11 编辑：载荷包含不支持的字段时报错并点名', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, { mode: 'edit', status: 'closed' });
    const { code, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /不支持的字段：status/);
  });
});

// ---------------------------------------------------------------- 批量（--ids）

test('B01 批量解决：预检过滤已 resolved/closed 的，其余串行写入并逐条回读，三栏汇报', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([
    [1901, seedBug({ id: 1901, status: 'active' })],
    [1902, seedBug({ id: 1902, status: 'resolved', resolution: 'fixed' })],
    [1903, seedBug({ id: 1903, status: 'closed' })],
  ]);
  await withMock({ bugs }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-resolve', '--ids', '1901,1902,1903', '--resolution', 'fixed'],
      env,
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.batch, true);
    assert.deepEqual(result.counts, { succeeded: 1, skipped: 2, failed: 0 });
    assert.deepEqual(result.succeeded.map((s) => s.id), [1901]);
    assert.equal(result.succeeded[0].status, 'resolved');
    assert.deepEqual(result.skipped.map((s) => s.id).sort(), [1902, 1903]);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 1, '预检不过的不发请求');
  });
});

test('B02 批量改派：edit 模式批量只改 assignedTo，逐条回读并保留其它字段', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([
    [1901, seedBug({ id: 1901 })],
    [1902, seedBug({ id: 1902, title: '另一条缺陷' })],
  ]);
  await withMock({ bugs }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--ids', '1901,1902', '--assigned-to', 'dev-c'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.batch, true);
    assert.deepEqual(result.counts, { succeeded: 2, skipped: 0, failed: 0 });
    assert.equal(server.state.bugs.get(1901).assignedTo, 'dev-c');
    assert.equal(server.state.bugs.get(1902).title, '另一条缺陷', '批量改派不得覆盖标题');
    assert.equal(writesOf(server, 'PUT', '/bugs/1901').length, 1);
    assert.equal(writesOf(server, 'PUT', '/bugs/1902').length, 1);
  });
});

test('B03 批量上限：超过 20 条直接拒绝，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 1).join(',');
    const { code, stderr } = await runEntryScript(['bug-close', '--ids', ids], env);
    assert.equal(code, 1);
    assert.match(stderr, /单批最多支持 20 条/);
    assert.equal(server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('B04 批量：--id 与 --ids 不能同时用；--ids 含非数字报用法', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env }) => {
    const both = await runEntryScript(['bug-close', '--id', '1900', '--ids', '1901'], env);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--id 与 --ids 不能同时使用/);

    const bad = await runEntryScript(['bug-close', '--ids', '1901,abc'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /正整数/);
  });
});

test('B05 批量：部分失败时分三栏汇报、退出码非 0，且不自动重试', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([
    [1901, seedBug({ id: 1901 })],
    [1902, seedBug({ id: 1902, product: 999 })], // 当前账号看不见的产品 → 服务端业务失败
  ]);
  await withMock({ bugs, visibleProducts: { [ACCOUNT]: [101] } }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-close', '--ids', '1901,1902'], env);
    // 1901 是 active：默认工作流拒绝关闭 → failed；1902 产品不可见 → failed
    assert.equal(code, 1);
    assert.match(stderr, /存在失败/);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.counts.failed, 2);
    assert.ok(result.failed.every((f) => f.reason));
    assert.equal(writesOf(server, 'PUT', '/close').length, 2, '每条只发一次，不重试');
  });
});

test('B06 批量 --fail-fast：首个失败后剩余目标跳过并标注', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([
    [1901, seedBug({ id: 1901 })], // active → 关闭被拒
    [1902, seedBug({ id: 1902, status: 'resolved', resolution: 'fixed' })],
    [1903, seedBug({ id: 1903, status: 'resolved', resolution: 'fixed' })],
  ]);
  await withMock({ bugs }, async ({ server, env }) => {
    const { code, stdout } = await runEntryScript(['bug-close', '--ids', '1901,1902,1903', '--fail-fast'], env);
    assert.equal(code, 1);
    const result = singleLineJson(stdout);
    assert.equal(result.counts.failed, 1);
    assert.deepEqual(result.skipped.map((s) => s.id).sort(), [1902, 1903]);
    assert.ok(result.skipped.every((s) => /fail-fast/.test(s.reason)));
    assert.equal(writesOf(server, 'PUT', '/close').length, 1, '失败后不再继续写');
  });
});

test('B07 批量：目标不存在（404）计入 failed，其余照常', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([[1901, seedBug({ id: 1901, status: 'resolved', resolution: 'fixed' })]]);
  await withMock({ bugs }, async ({ env }) => {
    const { code, stdout } = await runEntryScript(['bug-close', '--ids', '1901,9999'], env);
    assert.equal(code, 1);
    const result = singleLineJson(stdout);
    assert.equal(result.counts.succeeded, 1);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.failed[0].stage, 'preflight');
  });
});

test('B08 批量：服务端静默失败（成功但没生效）→ 回读不一致计入 failed，updated:true', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([[1901, seedBug({ id: 1901 })]]);
  await withMock({ bugs, noopTransitions: ['resolve'] }, async ({ env }) => {
    const { code, stdout } = await runEntryScript(['bug-resolve', '--ids', '1901', '--resolution', 'fixed'], env);
    assert.equal(code, 1);
    const result = singleLineJson(stdout);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.failed[0].updated, true);
    assert.equal(result.failed[0].uncertain, false);
    assert.match(result.failed[0].reason, /状态/);
  });
});

test('B09 批量：写请求超时后回读核实到已生效 → 计入 succeeded 且 verified:query', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([[1901, seedBug({ id: 1901 })]]);
  await withMock({ bugs }, async ({ server, env, dir }) => {
    const shim = installCliShim(dir, ZENTAO_CLI, { source: LOSSY_SHIM('resolve') });
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-resolve', '--ids', '1901', '--resolution', 'fixed'],
      { ...env, ...shim.env },
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.counts.succeeded, 1);
    assert.equal(result.succeeded[0].verified, 'query');
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 1, '结果不明也不重放');
  });
});

test('B10 批量编辑：批量不允许改标题或正文', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1901, seedBug({ id: 1901 })]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, { mode: 'edit', title: '批量改标题', expectedTitle: '设备列表导出按钮点击后无响应' });
    const { code, stderr } = await runEntryScript(['bug-update', '--ids', '1901', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /批量更新仅支持非正文统一字段编辑/);
  });
});

// ---------------------------------------------------------------- 预览（--preview）

test('P01 --preview 只读：逐条预检并给出可执行 / 跳过 / 失败清单，不发任何写请求', { skip: NEEDS_CLI }, async () => {
  const bugs = new Map([
    [1901, seedBug({ id: 1901 })],
    [1902, seedBug({ id: 1902, status: 'resolved', resolution: 'fixed' })],
  ]);
  await withMock({ bugs }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--ids', '1901,1902,9999', '--resolution', 'fixed', '--preview'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.preview, true);
    assert.equal(result.total, 3);
    assert.deepEqual(result.executable.map((e) => e.id), [1901]);
    assert.deepEqual(result.skipped.map((s) => s.id), [1902]);
    assert.deepEqual(result.failed.map((f) => f.id), [9999]);
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 0, '预览不写入');
  });
});

test('P02 --preview 与 --payload-file 同用时不删载荷文件（预览不该有副作用）', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1901, seedBug({ id: 1901 })]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, { comment: '预览备注' });
    const { code } = await runEntryScript(['bug-resolve', '--id', '1901', '--resolution', 'fixed', '--payload-file', file, '--preview'], env);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(file), '预览不应删除调用方给的载荷文件');
  });
});

// ---------------------------------------------------------------- 结果不确定（单条）

test('U01 单条流转超时：回读核实到已生效 → verified:query，不重放', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const shim = installCliShim(dir, ZENTAO_CLI, { source: LOSSY_SHIM('resolve') });
    const { code, stdout, stderr } = await runEntryScript(
      ['bug-resolve', '--id', '1900', '--resolution', 'fixed'],
      { ...env, ...shim.env },
    );
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.verified, 'query');
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 1);
  });
});

test('U02 单条流转静默失败：回读对不上 → updated:true + mismatches，不重放', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]), noopTransitions: ['resolve'] }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed'], env);
    assert.equal(code, 1);
    assert.match(stderr, /回读核对没通过/);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.updated, true);
    assert.ok(result.mismatches.some((m) => /状态/.test(m)));
    assert.equal(writesOf(server, 'PUT', '/resolve').length, 1);
  });
});

test('U03 CLI 不返回 actions（真实 0.4.4 形状）：状态与字段对上就判成功', { skip: NEEDS_CLI }, async () => {
  // 服务端记录本身就不带 actions 字段：真实 CLI 0.4.4 的 get 不映射流水，回读里根本没这个字段
  const noActions = seedBug();
  delete noActions.actions;
  await withMock({ bugs: new Map([[1900, noActions]]), omitActions: true }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed'], env);
    assert.equal(code, 0, stderr);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(result.newActions, []);
  });
});

// ---------------------------------------------------------------- 护栏边界

test('G01 物理删除不开放：没有 delete 子命令，命令行透传也被拒绝', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const r = await runEntryScript(['bug-delete', '--id', '1900'], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /未知子命令：bug-delete/);
    assert.equal(writesOf(server, 'DELETE', '/bugs/1900').length, 0);
  });
});

test('G02 未知选项报用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env }) => {
    const r = await runEntryScript(['bug-resolve', '--id', '1900', '--resolution', 'fixed', '--bogus', 'x'], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /不认这些选项：--bogus/);
    assert.equal(server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('G03 单据不存在：退出码非 0，错误可读', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['bug-resolve', '--id', '9999', '--resolution', 'fixed'], env);
    assert.equal(code, 1);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.match(stderr, /^错误：/);
  });
});

test('G04 备注与正文不进命令行参数：经 --data @<临时文件> 交给 CLI', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ env, dir }) => {
    const shim = installCliShim(dir, ZENTAO_CLI);
    const privateComment = '这段备注不该进命令行参数-包含中文';
    const { code, stderr } = await runEntryScript(
      ['bug-resolve', '--id', '1900', '--resolution', 'fixed', '--comment', privateComment],
      { ...env, ...shim.env },
    );
    assert.equal(code, 0, stderr);
    const argvList = shim.calls();
    const resolveArgv = argvList.find((argv) => argv.includes('resolve'));
    assert.ok(resolveArgv, '应该调起过 bug resolve');
    assert.equal(resolveArgv[resolveArgv.indexOf('--data') + 1].startsWith('@'), true, '备注要经 --data @文件');
    for (const argv of argvList) {
      assert.ok(!argv.join(' ').includes('这段备注不该进命令行参数'), `备注不该进 argv：${argv.join(' ')}`);
    }
  });
});

test('G05 位置参数不再被静默忽略：按用法错误退 2', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env }) => {
    const r = await runEntryScript(['bug-close', '1900'], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /意外的位置参数/);
  });
});
