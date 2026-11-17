// 第一层测试（模拟层）：在 mock MCP 上验证技能流程的关键行为与安全规则。
// 运行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-zentao-mcp.mjs';
import { McpClient } from './mcp-client.mjs';
import { FeedbackAssistant } from './skill-flow.mjs';

async function withAssistant(overrides, fn) {
  const server = await startMockServer(overrides);
  const client = new McpClient(server.url, { timeoutMs: 800 });
  await client.initialize();
  const state = server.state;
  const calls = (name) => state.calls.filter((c) => c.name === name);
  try {
    await fn({ client, state, calls, close: server.close });
  } finally {
    await server.close();
  }
}

const PRODUCT_ID = 101;
const DRAFT = {
  title: '设备列表导出按钮点击后无响应',
  desc: '【业务场景】\n运维导出月度报表。\n\n【复现步骤】\n1. 打开设备管理\n2. 点导出\n\n【实际结果】\n无响应。\n\n【预期结果】\n应导出 Excel。',
  type: 'bug',
  productId: PRODUCT_ID,
};

test('T04 用户取消提交：不发生任何写入', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => false });
    const result = await assistant.submit(DRAFT);
    assert.equal(result.status, 'cancelled');
    assert.equal(calls('post_feedbacks').length, 0);
    assert.equal(state.feedbacks.size, 0);
  });
});

test('T05 查重命中相似反馈时给出候选，并可选择新建', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    state.feedbacks.set('100', {
      id: 100, product: PRODUCT_ID, title: '设备列表导出无响应', desc: '', type: 'bug', status: 'wait',
      assignedTo: '', feedbackBy: 'mock', actions: [{ action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' }],
    });
    let seen = null;
    const assistant = new FeedbackAssistant({
      client,
      confirm: async (payload) => { seen = payload; return true; },
    });
    const result = await assistant.submit(DRAFT);
    assert.ok(seen.duplicates.length >= 1, '应给出重复候选');
    assert.equal(seen.duplicates[0].id, 100);
    assert.equal(result.status, 'created');
    assert.equal(calls('post_feedbacks').length, 1);
  });
});

test('T06 正常创建：返回 ID 且回读一致', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit(DRAFT);
    assert.equal(result.status, 'created');
    assert.ok(result.id, '应返回反馈 ID');
    assert.equal(result.detail.feedback.title, DRAFT.title);
    assert.equal(result.detail.feedback.desc, DRAFT.desc);
    assert.equal(result.detail.status, 'wait');
    assert.ok(result.detail.actions.includes('opened'), '操作流水应包含 opened');
  });
});

test('写入类调用必须把参数包在 payload 内', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    await assistant.submit(DRAFT);
    for (const call of calls('post_feedbacks')) {
      assert.ok(call.args.payload, 'post_feedbacks 必须使用 payload 包装');
      assert.equal(call.args.title, undefined);
    }
  });
});

test('T10 补充反馈：保留原文并回读验证', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const created = await assistant.submit(DRAFT);
    const result = await assistant.supplement({ id: created.id, addition: '必须先选中至少一行设备才能复现。' });
    assert.equal(result.status, 'updated');
    const put = calls('put_feedbacks_feedbackID')[0];
    assert.ok(put.args.payload, 'put_feedbacks_feedbackID 必须使用 payload 包装');
    assert.ok(put.args.payload.desc.includes(DRAFT.desc), '更新后描述必须包含原文');
    assert.ok(put.args.payload.desc.includes('必须先选中至少一行设备'), '更新后描述必须包含追加内容');
    const detail = await assistant.readBack(created.id);
    assert.ok(detail.actions.includes('edited'), '操作流水应包含 edited');
  });
});

test('T11 登录失效：重新登录一次后继续', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    await assistant.login();
    client.sessionId = 'unknown-session'; // 触发 401
    const result = await assistant.submit(DRAFT);
    assert.equal(result.status, 'created');
    assert.ok(calls('post_users_login').length >= 2, '应重新登录一次');
  });
});

test('T11 登录持续失败：停止操作且不写入', async () => {
  await withAssistant({ loginFails: true }, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    await assert.rejects(() => assistant.submit(DRAFT), (err) => err.code === 'auth_failed');
    assert.equal(calls('post_feedbacks').length, 0);
  });
});

test('T12 创建超时：先查核实，不重复创建', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '超时场景 __TIMEOUT__ 设备导出无响应' });
    assert.equal(result.status, 'created');
    assert.equal(result.recovered, true, '应通过查询核实到已创建');
    assert.equal(calls('post_feedbacks').length, 1, '不得重复创建');
    assert.equal(state.feedbacks.size, 1);
  });
});

test('T13 返回成功但未落库：回读发现不一致且不重试', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '静默失败 __NOOP__ 场景' });
    assert.equal(result.status, 'inconsistent');
    assert.equal(calls('post_feedbacks').length, 1, '不一致时不得自动重试创建');
  });
});

test('业务失败（status: fail）按失败处理', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '__FAIL__ 非法产品' });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /Product does not exist/);
    assert.equal(calls('post_feedbacks').length, 1);
  });
});

test('扁平参数（未包 payload）会被服务端忽略并报业务错', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    await client.callTool('post_users_login', { payload: { account: 'mock', password: 'mock' } });
    const res = await client.callTool('post_feedbacks', { title: '扁平参数', product: PRODUCT_ID });
    assert.equal(res.status, 'fail');
    assert.match(JSON.stringify(res.data.message), /反馈名称/);
    assert.equal(calls('post_feedbacks').length, 1);
  });
});

test('T07/T08/T09 查询与解释：事实、推断、无法确定分段', async () => {
  await withAssistant({}, async ({ client }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const created = await assistant.submit(DRAFT);
    const detail = await assistant.readBack(created.id);
    assert.equal(detail.status, 'wait');
    assert.equal(detail.assignedTo, '');
    assert.ok(detail.actions.includes('opened'));

    const explained = await assistant.explain(created.id);
    assert.ok(explained.facts.some((f) => f.includes('当前状态')));
    assert.ok(explained.facts.some((f) => f.includes('opened')), '时间线应来自 actions');
    assert.ok(explained.unknown.some((u) => u.includes('未排期')), '排期原因应归入无法确定');
    assert.ok(!explained.facts.some((f) => f.includes('拒绝')), '不得把未排期说成被拒绝');
  });
});

test('T15 每用户账号：反馈留痕在当前登录账号上', async () => {
  await withAssistant({}, async ({ client, state }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const created = await assistant.submit(DRAFT);
    const fb = state.feedbacks.get(String(created.id));
    assert.equal(fb.feedbackBy, 'mock', '记录留痕在当前登录账号上');
  });
});

test('T16 MCP 未注册：给安装指引，不给原始错误', async () => {
  await withAssistant({ hideTools: true }, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    await assert.rejects(
      () => assistant.ensureEnvironment(),
      (err) => err.code === 'mcp_not_configured' && /setup\.md/.test(err.message) && /config\.local\.json/.test(err.message),
    );
    assert.equal(calls('post_feedbacks').length, 0, '未注册时不得写入');
  });
});

test('T17 未认证：给凭据写入指引，不在对话里索要密码', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true, credentials: null });
    await assert.rejects(
      () => assistant.submit(DRAFT),
      (err) => err.code === 'not_authenticated' && /setup\.md/.test(err.message),
    );
    assert.equal(calls('post_feedbacks').length, 0, '未认证不得写入');
  });
});

test('T18 权限差异：产品列表与写入都受当前账号权限限制', async () => {
  await withAssistant({ visibleProducts: { mock: [101] } }, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const products = await assistant.listProducts();
    assert.deepEqual(products.map((p) => p.id), [101], '只应看到有权限的产品');
    const result = await assistant.submit({ ...DRAFT, productId: 102 });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /Product does not exist/);
    assert.equal(calls('post_feedbacks').length, 1);
  });
});
