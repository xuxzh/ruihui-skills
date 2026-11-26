import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS } from './mock-zentao-api.mjs';
import { findZentaoCli, installCliShim, runEntryScript, withMockApi } from './zentao-client.mjs';

const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本靠官方禅道 CLI 取数写数；没装就别假装测过
const ZENTAO_CLI = findZentaoCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

/**
 * 起假服务 + 隔离的本机配置：凭据、config.local.json（随包默认）、preferences.json（本机偏好）
 * 都落在临时目录里，测试不碰开发者本机的真实配置。
 */
const withMock = (opts, fn) =>
  withMockApi({ tag: 'rh-cli-feedback', config: { bugAssignee: '' }, preferences: {}, ...opts }, fn);

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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.equal(body.feedbackBy, ACCOUNT, '反馈者要显式写当前禅道账号');
    assert.equal(singleLineJson(stdout).feedbackBy, ACCOUNT);
  });
});

test('F03 反馈者不让 Agent 手工填别人：载荷里填了别的账号就报错，不建单', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ feedbackBy: 'someone-else' }));
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /product/);
    assert.equal(creates(server).length, 0);
  });
});

test('F06 来源与模块不填：载荷里带了也不发出去', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ source: 'customer', module: '设备管理' }));
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const body = createdBody(server);
    assert.ok(!('source' in body), `来源不该发出去：${JSON.stringify(body)}`);
    assert.ok(!('module' in body), `模块不该发出去：${JSON.stringify(body)}`);
  });
});

test('F07 正文是纯文本描述：原样送到 desc，不带 HTML 标签', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /纯文本/);
    assert.equal(creates(server).length, 0);
  });
});

test('F09 提交人核对看创建者字段：反馈者字段为空时仍判定提交人是当前账号', { skip: NEEDS_CLI }, async () => {
  // 这台实例不记录反馈者字段：回读到的记录 feedbackBy 是空的，留痕主体是创建者
  await withMock({ feedbacks: new FeedbacksWithoutFeedbackBy() }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const shim = installCliShim(dir, ZENTAO_CLI);
    const { code, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], { ...env, ...shim.env });
    assert.equal(code, 0, stderr);

    const argvList = shim.calls();
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
    const { code, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 1, '失败也不能自动重发');
  });
});

test('F14 回读核对不通过：正文被服务端改写就报不一致，不重建', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__ALTERED_DESC__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷缺必填字段：product/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 0);
  });
});

test('F16 没给 --payload-file：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['feedback-create'], env);
    assert.equal(code, 2);
    assert.match(stderr, /^错误：用法：.*feedback-create --payload-file/);
    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('F17 结果不确定（超时）：不重发，查询核实到唯一一致的新记录后按创建成功交付', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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

/** 一条已存在的反馈：用来验证 v2 详情 403 时的 v1 回退（详情、回读、更新复核）。 */
function seedOneFeedback(overrides = {}) {
  return {
    id: 900,
    title: '设备列表导出按钮点击后无响应',
    status: 'active',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: '',
    product: 101,
    desc: DESC_TEXT,
    type: 'bug',
    feedbackBy: ACCOUNT,
    actions: [{ id: 9000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
    ...overrides,
  };
}

// 已经有 25 条反馈的产品：基线扫描超过一页（假服务每页 20 条）
function manyFeedbacks(count) {
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const id = 700 + i;
    map.set(id, {
      id,
      product: 101,
      title: `历史反馈 ${i + 1}`,
      status: 'wait',
      type: 'advice',
      openedBy: ACCOUNT,
      openedDate: '2026-11-01 10:00:00',
      feedbackBy: ACCOUNT,
      assignedTo: '',
      desc: '历史正文',
      actions: [{ id: id * 10, action: 'opened', actor: ACCOUNT, date: '2026-11-01 10:00:00', comment: '' }],
    });
  }
  return map;
}

test('F19 查重基线不完整（服务端分页不前进）：建单后只能报「是否新建未确认」，不判成功、不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: manyFeedbacks(25), pagingStuckProducts: [101] }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload({ title: '__TIMEOUT__ 设备列表导出无响应' }));
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
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

test('F20 回读没有 actions（真实 CLI 0.4.4 形状）：openedBy / openedDate 可核对就判成功', { skip: NEEDS_CLI }, async () => {
  await withMock({ omitActions: true }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.verified, 'readback');
    assert.equal(result.openedBy, ACCOUNT);
    assert.equal(result.submitterField, 'openedBy');
    assert.equal(result.submitterIsCurrentAccount, true);

    assert.equal(creates(server).length, 1, '创建请求只能发一次');
    assert.equal(readsOf(server, 900).length, 1, '写入后要按返回的编号回读一次');
  });
});

test('F21 v2 反馈详情 403：同一账号 token 回退 v1，详情字段归一化后交付', { skip: NEEDS_CLI }, async () => {
  const feedback = seedOneFeedback();
  await withMock({ feedbacks: new Map([[900, feedback]]), feedbackV2GetDenied: true }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['feedback', '--id', '900'], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 900);
    assert.equal(result.title, feedback.title);
    assert.equal(result.status, feedback.status);
    assert.equal(result.openedBy, ACCOUNT, 'v1 的 openedBy 对象要归一成账号字符串');
    assert.equal(result.assignee, '', 'v1 的 assignedTo=null 要归一成空串');
    assert.equal(result.body, DESC_TEXT, 'v1 的 HTML 正文要归一成纯文本');
    assert.deepEqual(result.actions.map((action) => action.action), ['opened']);

    assert.ok(
      server.state.calls.some((call) => call.method === 'GET' && call.path === '/api.php/v2/feedbacks/900'),
      '先试 v2 详情',
    );
    assert.ok(
      server.state.calls.some((call) => call.method === 'GET' && call.path === '/api.php/v1/feedbacks/900'),
      'v2 403 后回退 v1 详情',
    );
  });
});

test('F22 建单回读遇到 v2 403：回退 v1 后仍按 readback 交付', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbackV2GetDenied: true }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 900);
    assert.equal(result.verified, 'readback');
    assert.equal(result.openedBy, ACCOUNT);
    assert.equal(result.submitterIsCurrentAccount, true);

    assert.equal(creates(server).length, 1, '创建请求只能发一次');
    assert.ok(
      server.state.calls.some((call) => call.method === 'GET' && call.path === '/api.php/v1/feedbacks/900'),
      '回读要走 v1',
    );
  });
});

test('F23 v2 与 v1 都拒绝：建单报 created + readbackDenied，不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbackV2GetDenied: true, feedbackV1GetDenied: true }, async ({ server, env, dir }) => {
    const file = writePayload(dir, feedbackPayload());
    const { code, stdout, stderr } = await runEntryScript(['feedback-create', '--payload-file', file], env);
    assert.equal(code, 1);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.id, 900, '编号已经拿到，要交代清楚');
    assert.equal(result.created, true);
    assert.equal(result.readbackDenied, true);
    assert.equal(result.uncertain, undefined, '编号已知时不要报成结果不确定');
    assert.match(stderr, /无权回读详情/);
    assert.equal(creates(server).length, 1, '不重发');
  });
});

test('F24 回退开关关闭：v2 403 不再请求 v1', { skip: NEEDS_CLI }, async () => {
  const feedback = seedOneFeedback();
  await withMock({ feedbacks: new Map([[900, feedback]]), feedbackV2GetDenied: true }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['feedback', '--id', '900'], {
      ...env,
      ZENTAO_FEEDBACK_V1_FALLBACK: '0',
    });
    assert.equal(code, 1);
    assert.match(stderr, /2006/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.ok(
      !server.state.calls.some((call) => call.path === '/api.php/v1/feedbacks/900'),
      '开关关闭时不该请求 v1',
    );
  });
});

test('F25 v2 返回非权限错误：不回退 v1，保持原错误', { skip: NEEDS_CLI }, async () => {
  const feedback = seedOneFeedback();
  await withMock(
    { feedbacks: new Map([[900, feedback]]), failPaths: ['/api.php/v2/feedbacks/900'] },
    async ({ server, env }) => {
      const { code } = await runEntryScript(['feedback', '--id', '900'], env);
      assert.equal(code, 1);
      assert.ok(
        !server.state.calls.some((call) => call.path === '/api.php/v1/feedbacks/900'),
        '只有 v2 明确返回 2006 才回退',
      );
    },
  );
});

test('F26 反馈补充说明：v2 详情被拒时 CLI 的 autoFill 无法工作，明确报未写入', { skip: NEEDS_CLI }, async () => {
  const feedback = seedOneFeedback();
  await withMock({ feedbacks: new Map([[900, feedback]]), feedbackV2GetDenied: true }, async ({ server, env, dir }) => {
    const addition = '补充：必须先选中至少一行设备，点「导出」才复现。';
    const separator = '──────────────';
    const annotation = '【补充说明 · 2026-11-20 · 用户口述，AI 整理】';
    const draft = `${feedback.desc}\n\n${separator}\n${annotation}\n${addition}`;
    const file = writePayload(dir, {
      product: feedback.product,
      title: feedback.title,
      desc: draft,
      expectedBody: feedback.desc,
    });

    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 1);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.id, 900);
    assert.equal(result.writeBlocked, true);
    assert.match(stderr, /更新请求没有发出/);
    assert.match(stderr, /autoFill|自动补全/);

    const updates = server.state.calls.filter(
      (call) => call.method === 'PUT' && call.path === '/api.php/v2/feedbacks/900',
    );
    assert.equal(updates.length, 0, '不发出更新请求');
    const v2Reads = server.state.calls.filter(
      (call) => call.method === 'GET' && call.path === '/api.php/v2/feedbacks/900',
    );
    assert.equal(v2Reads.length, 1, '只试过写前复核，没有让 CLI 再走一次 autoFill');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');
  });
});
