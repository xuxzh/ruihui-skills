// 第一层测试（模拟层）：在 mock MCP 上验证技能流程的关键行为与安全规则。
// 运行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-zentao-mcp.mjs';
import { McpClient } from './mcp-client.mjs';
import { FeedbackAssistant, DefectAssistant, pickProduct } from './skill-flow.mjs';
import { runLiveE2E, runLiveBugE2E, resolveWriteGate } from './e2e-live-flow.mjs';

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
// ---- Issue #4：写入安全与回读一致性 ---------------------------------------
test('T19 写入前已存在的同名反馈 + 写入超时未落库：不得误报 created', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const draft = { ...DRAFT, title: '旧同名反馈 __TIMEOUT_GHOST__ 设备导出无响应' };
    // 写入前就存在一条标题与描述完全相同的反馈：只看「同名 + 已落库」会把它误当成新建成功
    state.feedbacks.set('100', {
      id: 100, product: PRODUCT_ID, title: draft.title, desc: draft.desc, type: 'bug', status: 'wait',
      assignedTo: '', feedbackBy: 'mock', actions: [{ action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' }],
    });
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit(draft);
    assert.notEqual(result.status, 'created', '写入前已存在的同名反馈不得被当成新建成功');
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'no_match');
    assert.equal(calls('post_feedbacks').length, 1, '不得重复创建');
    assert.equal(state.feedbacks.size, 1, '不得产生新记录');
  });
});
test('T20 真正的写入超时且已落库：按新增 ID 唯一恢复', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '超时场景 __TIMEOUT__ 设备导出无响应' });
    assert.equal(result.status, 'created');
    assert.equal(result.recovered, true, '应通过查询核实到已创建');
    assert.equal(String(result.id), '900', '恢复出的应是本次新增的 ID，而不是写入前已有的记录');
    assert.equal(result.detail.feedback.desc, DRAFT.desc, '恢复出的记录描述必须与本次提交的完整描述一致');
    assert.ok(result.detail.actions.includes('opened'));
    assert.equal(calls('post_feedbacks').length, 1, '不得重复创建');
    assert.equal(state.feedbacks.size, 1);
  });
});
test('T21 返回成功但操作流水没有 opened：不能报成功', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '无 opened 流水 __NO_OPENED__ 场景' });
    assert.equal(result.status, 'inconsistent');
    assert.ok(!result.detail.actions.includes('opened'));
    assert.equal(calls('post_feedbacks').length, 1);
  });
});
test('T22 返回成功但描述被服务端改写：不能报成功', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.submit({ ...DRAFT, title: '描述被改写 __ALTERED_DESC__ 场景' });
    assert.equal(result.status, 'inconsistent');
    assert.notEqual(result.detail.feedback.desc, DRAFT.desc);
    assert.equal(calls('post_feedbacks').length, 1);
  });
});
test('T23 补充说明前出现并发修改：停止写入，不覆盖新原文', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const created = await assistant.submit(DRAFT);
    const concurrentDesc = '他人先改的原文：已补充新的复现信息';
    const concurrent = new FeedbackAssistant({
      client,
      // 用户确认之后、写入之前，别人改了同一条反馈
      confirm: async () => {
        state.feedbacks.get(String(created.id)).desc = concurrentDesc;
        return true;
      },
    });
    const result = await concurrent.supplement({ id: created.id, addition: '补充：必须先选中至少一行设备。' });
    assert.equal(result.status, 'conflict');
    assert.equal(result.writes, 0);
    assert.equal(result.needsUserDecision, true);
    assert.equal(calls('put_feedbacks_feedbackID').length, 0, '发现并发修改时不得写入');
    assert.equal(state.feedbacks.get(String(created.id)).desc, concurrentDesc, '不得覆盖他人刚写入的原文');
  });
});
test('T24 历史已有 edited 且原文已含追加内容，本次更新未生效：不能报成功', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const addition = '补充：这次没有生效。';
    state.feedbacks.set('200', {
      id: 200, product: PRODUCT_ID, title: '更新未生效 __NOOP_UPDATE__ 场景', desc: `原始描述\n\n${addition}`, type: 'bug', status: 'wait',
      assignedTo: '', feedbackBy: 'mock',
      actions: [
        { action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' },
        { action: 'edited', actor: 'mock', comment: '', date: '2026-03-05 10:00' },
      ],
    });
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.supplement({ id: 200, addition });
    assert.equal(result.status, 'inconsistent');
    assert.equal(state.feedbacks.get('200').desc, `原始描述\n\n${addition}`, '未生效时描述不得变化');
    const detail = await assistant.readBack(200);
    assert.equal(detail.actions.filter((a) => a === 'edited').length, 1, '不得新增 edited 流水');
    assert.equal(calls('put_feedbacks_feedbackID').length, 1);
  });
});
test('T25 历史已有 edited，本次更新新增了 edited：可以报成功', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    state.feedbacks.set('201', {
      id: 201, product: PRODUCT_ID, title: '历史已编辑过 场景', desc: '原始描述', type: 'bug', status: 'wait',
      assignedTo: '', feedbackBy: 'mock',
      actions: [
        { action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' },
        { action: 'edited', actor: 'mock', comment: '', date: '2026-03-05 10:00' },
      ],
    });
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    const result = await assistant.supplement({ id: 201, addition: '补充：这次生效了。' });
    assert.equal(result.status, 'updated');
    const detail = await assistant.readBack(201);
    assert.equal(detail.actions.filter((a) => a === 'edited').length, 2, '本次应新增一条 edited 流水');
  });
});
test('T26 创建调用缺必填字段：服务端参数错误，按失败处理且不重试', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new FeedbackAssistant({ client, confirm: async () => true });
    // 真实 MCP：payload 在、但缺必填字段时返回 JSON-RPC -32602（HTTP 200，正文是 error）
    const result = await assistant.submit({ ...DRAFT, productId: undefined });
    assert.equal(result.status, 'failed', '请求被拒绝不是「结果不确定」，也不是「返回成功」');
    assert.match(result.message, /invalid params|参数/);
    assert.equal(calls('post_feedbacks').length, 1, '不得重试');
    assert.equal(state.feedbacks.size, 0, '不得落库');
  });
});
test('T27 MCP 的 JSON-RPC 错误要能被识别，不能被当成空响应', async () => {
  await withAssistant({}, async ({ client }) => {
    const res = await client.callTool('post_feedbacks', { payload: { desc: '缺字段' } });
    assert.equal(res.isError, true);
    assert.equal(res.error?.code, -32602);
    assert.equal(res.status, null, '没有业务状态 = 结果不确定，不能当成成功');
  });
});
// ---- Issue #4：真实 E2E 的写入保护（全部在 mock MCP 上验证，不碰真实禅道） ----
const LIVE_ENV = {
  ZENTAO_E2E_ALLOW_WRITE: '1',
  ZENTAO_E2E_PRODUCT: '101',
  ZENTAO_E2E_ALLOWED_PRODUCTS: '101',
};
test('L01 默认只读：没有写入开关时不产生任何写入', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const result = await runLiveE2E({
      client,
      env: { ZENTAO_E2E_PRODUCT: '101', ZENTAO_E2E_ALLOWED_PRODUCTS: '101' },
    });
    assert.equal(result.exitCode, 0, '只读验证应通过');
    assert.equal(calls('post_feedbacks').length, 0, '未开启写入开关时不得写入');
    assert.equal(state.feedbacks.size, 0);
  });
});
test('L02 写入闸门缺一不可：缺允许清单时不得写入', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const env = { ZENTAO_E2E_ALLOW_WRITE: '1', ZENTAO_E2E_PRODUCT: '101' };
    assert.equal(resolveWriteGate(env).allowed, false);
    const result = await runLiveE2E({ client, env });
    assert.notEqual(result.exitCode, 0, '声明了写入意图但条件不满足，不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 0, '不得写入');
  });
});
test('L03 目标产品不在允许清单：不得写入', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const env = { ...LIVE_ENV, ZENTAO_E2E_ALLOWED_PRODUCTS: '102' };
    const result = await runLiveE2E({ client, env });
    assert.notEqual(result.exitCode, 0, '产品不在白名单时不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 0, '不得写入');
  });
});
test('L04 目标产品不存在：前置自检失败，不得写入', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const env = { ...LIVE_ENV, ZENTAO_E2E_PRODUCT: '999', ZENTAO_E2E_ALLOWED_PRODUCTS: '999' };
    const result = await runLiveE2E({ client, env });
    assert.notEqual(result.exitCode, 0, '目标产品不存在时不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 0, '前置自检失败不得写入');
  });
});
test('L05 清理失败：整体不通过，并报告记录仍存在', async () => {
  await withAssistant({ deleteFails: true }, async ({ client, state, calls }) => {
    const result = await runLiveE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '清理失败不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 1, '写入只发生一次');
    assert.equal(state.feedbacks.size, 1, '清理失败时记录应仍在，需人工处理');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('清理')), '应报告清理失败');
  });
});
test('L06 创建超时且未落库：报告未确认、只调用一次创建', async () => {
  await withAssistant({ createHang: 'ghost' }, async ({ client, state, calls }) => {
    const result = await runLiveE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '创建结果不确定时不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 1, '不得重复创建');
    assert.equal(state.feedbacks.size, 0, '未落库时不应产生记录');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('创建结果确认')), '应报告创建结果未确认');
  });
});
test('L07 创建超时且已落库：按唯一标识查到残留、报告并清理', async () => {
  await withAssistant({ createHang: 'persist' }, async ({ client, state, calls }) => {
    const result = await runLiveE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '有残留风险时必须以非零退出码结束');
    assert.equal(calls('post_feedbacks').length, 1, '不得重复创建');
    const residualStep = result.steps.find((s) => s.name.includes('创建结果确认'));
    assert.ok(residualStep && !residualStep.ok, '应报告残留风险');
    assert.match(residualStep.detail, /残留记录/, '应列出可能残留的记录');
    assert.equal(state.feedbacks.size, 0, '标识匹配的记录应被清理');
  });
});
test('L08 写入与清理全部成功：整体通过，且不残留记录', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const result = await runLiveE2E({ client, env: LIVE_ENV });
    assert.equal(result.exitCode, 0, `整体应通过：${JSON.stringify(result.steps.filter((s) => !s.ok))}`);
    assert.equal(calls('post_feedbacks').length, 1);
    assert.equal(calls('delete_feedbacks_feedbackID').length, 1, '只清理本次创建的记录');
    assert.equal(state.feedbacks.size, 0, '不得残留测试记录');
  });
});
test('L09 前置自检读不到反馈：中止写入，整体不通过', async () => {
  await withAssistant({ visibleProducts: { mock: [] } }, async ({ client, calls }) => {
    const result = await runLiveE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '前置自检失败不得误报整体通过');
    assert.equal(calls('post_feedbacks').length, 0, '前置自检失败不得写入');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('前置自检')), '应报告前置自检失败');
  });
});

// ---- 缺陷单路径（禅道 bug 对象） ---------------------------------------

const BUG_STEPS = [
  '<p><strong>[步骤]</strong></p>',
  '<p>1. 打开「设备管理」</p>',
  '<p>2. 点「导出」</p>',
  '<p><strong>[实际结果]</strong></p>',
  '<p>页面无响应</p>',
  '<p><strong>[预期结果]</strong></p>',
  '<p>应导出 Excel</p>',
].join('');
const BUG_DRAFT = {
  title: '设备列表导出按钮点击后无响应',
  steps: BUG_STEPS,
  productId: PRODUCT_ID,
};

test('B01 正常创建缺陷：字段名用 productID、开销版本填 trunk，回读一致', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const result = await assistant.submitBug(BUG_DRAFT);
    assert.equal(result.status, 'created');
    assert.ok(result.id, '应返回缺陷 ID');
    const payload = calls('post_bugs')[0].args.payload;
    assert.equal(payload.productID, PRODUCT_ID);
    assert.equal(payload.product, undefined, '缺陷单用 productID，不该传 product');
    assert.deepEqual(payload.openedBuild, ['trunk']);
    assert.equal(payload.severity, 3);
    assert.equal(payload.pri, 3);
    assert.equal(result.detail.bug.product, PRODUCT_ID);
    assert.equal(result.detail.bug.title, BUG_DRAFT.title);
    assert.ok(result.detail.actions.includes('opened'), '操作流水应包含 opened');
    assert.equal(state.bugs.size, 1);
  });
});

test('B02 用户取消提交缺陷：不发生任何写入', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => false });
    const result = await assistant.submitBug(BUG_DRAFT);
    assert.equal(result.status, 'cancelled');
    assert.equal(calls('post_bugs').length, 0);
    assert.equal(state.bugs.size, 0);
  });
});

test('B03 缺陷查重：给出相近候选，仍可新建', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    state.bugs.set('1900', {
      id: 1900, product: PRODUCT_ID, project: 11, execution: 0, title: '设备列表导出无响应',
      steps: '', openedBuild: ['trunk'], severity: 3, pri: 3, type: 'codeerror', status: 'active',
      assignedTo: '张工', openedBy: 'mock', actions: [{ action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' }],
    });
    let seen = null;
    const assistant = new DefectAssistant({
      client,
      confirm: async (payload) => { seen = payload; return true; },
    });
    const result = await assistant.submitBug(BUG_DRAFT);
    assert.ok(seen.duplicates.length >= 1, '应给出缺陷候选');
    assert.equal(seen.duplicates[0].id, 1900);
    assert.equal(result.status, 'created');
    assert.equal(calls('post_bugs').length, 1);
  });
});

test('B04 字段名写错（传 product 而不是 productID）：参数校验拦下，请求未执行', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    await client.callTool('post_users_login', { payload: { account: 'mock', password: 'mock' } });
    const res = await client.callTool('post_bugs', {
      payload: { product: PRODUCT_ID, title: '字段名写错', openedBuild: ['trunk'] },
    });
    assert.ok(res.error, '应返回 JSON-RPC 参数错误');
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /productID/);
    assert.equal(calls('post_bugs').length, 1);
  });
});

test('B04b payload 整个缺失：落到禅道业务校验，报所属产品为空', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    await client.callTool('post_users_login', { payload: { account: 'mock', password: 'mock' } });
    const res = await client.callTool('post_bugs', { productID: PRODUCT_ID, title: '扁平参数' });
    assert.equal(res.status, 'fail');
    assert.match(JSON.stringify(res.data.message), /所属产品|缺陷标题/);
    assert.equal(calls('post_bugs').length, 1);
  });
});

test('B05 缺必填开销版本：服务端参数错误，按失败处理且不重试', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    await client.callTool('post_users_login', { payload: { account: 'mock', password: 'mock' } });
    const res = await client.callTool('post_bugs', { payload: { productID: PRODUCT_ID, title: '缺开销版本' } });
    assert.ok(res.error, '应返回 JSON-RPC 参数错误');
    assert.equal(res.error.code, -32602);
    assert.equal(calls('post_bugs').length, 1);
  });
});

test('B06 创建超时未落库：先查核实，不重复创建', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const result = await assistant.submitBug({ ...BUG_DRAFT, title: '超时未落库 __TIMEOUT_GHOST__ 设备导出无响应' });
    assert.notEqual(result.status, 'created');
    assert.equal(calls('post_bugs').length, 1, '不得重复创建');
    assert.equal(state.bugs.size, 0);
  });
});

test('B07 创建超时已落库：按唯一 ID 恢复', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const result = await assistant.submitBug({ ...BUG_DRAFT, title: '超时已落库 __TIMEOUT__ 设备导出无响应' });
    assert.equal(result.status, 'created');
    assert.equal(result.recovered, true, '应通过查询核实到已创建');
    assert.equal(calls('post_bugs').length, 1, '不得重复创建');
    assert.equal(state.bugs.size, 1);
  });
});

test('B08 禅道改写了正文：回读不一致，不能报成功', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const result = await assistant.submitBug({ ...BUG_DRAFT, title: '正文被改写 __ALTERED_STEPS__ 设备导出无响应' });
    assert.equal(result.status, 'inconsistent');
    assert.equal(calls('post_bugs').length, 1, '不一致时不得自动重试创建');
  });
});

test('B09 补充缺陷：原文保留、steps 追加、回读验证 edited 流水', async () => {
  await withAssistant({}, async ({ client }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const created = await assistant.submitBug(BUG_DRAFT);
    const result = await assistant.supplementBug({ id: created.id, addition: '补充：必须先选中至少一行设备才复现。' });
    assert.equal(result.status, 'updated');
    const after = await assistant.readBackBug(created.id);
    assert.ok(after.bug.steps.includes(BUG_STEPS), '原文应保留');
    assert.match(after.bug.steps, /补充说明/);
    assert.ok(after.actions.includes('edited'), '操作流水应新增 edited');
  });
});

test('B10 补充缺陷前出现并发修改：停止写入，不覆盖新正文', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const created = await assistant.submitBug(BUG_DRAFT);
    const concurrentSteps = '<p>别人改过的正文</p>';
    const concurrent = new DefectAssistant({
      client,
      // 用户确认之后、写入之前，别人改了同一条缺陷
      confirm: async () => {
        state.bugs.get(String(created.id)).steps = concurrentSteps;
        return true;
      },
    });
    const result = await concurrent.supplementBug({ id: created.id, addition: '补充内容' });
    assert.equal(result.status, 'conflict');
    assert.equal(result.writes, 0);
    assert.equal(result.needsUserDecision, true);
    assert.equal(calls('put_bugs_bugID').length, 0, '发现并发修改时不得写入');
    assert.equal(state.bugs.get(String(created.id)).steps, concurrentSteps, '不得覆盖他人内容');
  });
});

test('B11 缺陷查询与解释：事实、推断、无法确定分段', async () => {
  await withAssistant({}, async ({ client }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    const created = await assistant.submitBug(BUG_DRAFT);
    const result = await assistant.explainBug(created.id);
    assert.equal(result.status, 'ok');
    assert.ok(result.facts.some((f) => f.includes('当前状态：active')));
    assert.ok(result.facts.some((f) => f.includes('负责人：未指派')));
    assert.ok(result.inferences.length >= 1);
    assert.ok(result.unknown.some((u) => u.includes('resolution')));
  });
});

test('B12 缺陷单不指定所属执行；所属项目只在用户给出时带上', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const assistant = new DefectAssistant({ client, confirm: async () => true });
    await assistant.submitBug(BUG_DRAFT);
    assert.equal(calls('post_bugs')[0].args.payload.execution, undefined, '默认不挂执行');
    assert.equal(calls('post_bugs')[0].args.payload.project, undefined, '默认不挂项目');

    await assistant.submitBug({ ...BUG_DRAFT, title: '指定项目', project: 11 });
    const withProject = calls('post_bugs')[1].args.payload;
    assert.equal(withProject.project, 11);
  });
});

// ---- 缺陷单路径的真实写入闭环（全部在 mock MCP 上验证） -----------------

test('L10 缺陷写入闸门缺一不可：缺允许清单时不得写入', async () => {
  await withAssistant({}, async ({ client, calls }) => {
    const result = await runLiveBugE2E({
      client,
      env: { ZENTAO_E2E_ALLOW_WRITE: '1', ZENTAO_E2E_PRODUCT: '101' },
    });
    assert.notEqual(result.exitCode, 0, '闸门不满足不得误报整体通过');
    assert.equal(calls('post_bugs').length, 0, '闸门不满足不得写入');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('写入闸门')), '应报告闸门未通过');
  });
});

test('L11 缺陷写入与清理全部成功：整体通过，且不残留记录', async () => {
  await withAssistant({}, async ({ client, state, calls }) => {
    const result = await runLiveBugE2E({ client, env: LIVE_ENV });
    assert.equal(result.exitCode, 0, `整体应通过：${JSON.stringify(result.steps.filter((s) => !s.ok))}`);
    assert.equal(calls('post_bugs').length, 1);
    assert.equal(calls('delete_bugs_bugID').length, 1, '只清理本次创建的记录');
    assert.equal(state.bugs.size, 0, '不得残留测试记录');
  });
});

test('L12 缺陷清理失败：整体不通过，并报告记录仍存在', async () => {
  await withAssistant({ deleteFails: true }, async ({ client, state, calls }) => {
    const result = await runLiveBugE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '清理失败不得误报整体通过');
    assert.equal(calls('post_bugs').length, 1, '写入只发生一次');
    assert.equal(state.bugs.size, 1, '清理失败时记录应仍在，需人工处理');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('清理')), '应报告清理失败');
  });
});

test('L13 缺陷创建超时且未落库：报告未确认、只调用一次创建', async () => {
  await withAssistant({ createHang: 'ghost' }, async ({ client, state, calls }) => {
    const result = await runLiveBugE2E({ client, env: LIVE_ENV });
    assert.notEqual(result.exitCode, 0, '创建结果不确定时不得误报整体通过');
    assert.equal(calls('post_bugs').length, 1, '不得重复创建');
    assert.equal(state.bugs.size, 0, '未落库时不应产生记录');
    assert.ok(result.steps.some((s) => !s.ok && s.name.includes('创建结果确认')), '应报告创建结果未确认');
  });
});

// ---- 选品规则（默认产品） ------------------------------------------------

test('D01 用户明说的产品优先于默认产品', () => {
  const result = pickProduct({
    stated: { id: 101, name: '示例产品 A' },
    defaultProduct: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }, { id: 102 }],
  });
  assert.equal(result.status, 'stated');
  assert.equal(result.product.id, 101);
});

test('D02 没明说就用默认产品', () => {
  const result = pickProduct({
    defaultProduct: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }, { id: 102 }],
  });
  assert.equal(result.status, 'default');
  assert.equal(result.product.id, 102);
});

test('D03 默认产品不可见：如实说明并追问，不静默换产品', () => {
  const result = pickProduct({
    defaultProduct: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }],
  });
  assert.equal(result.status, 'not_visible');
  assert.equal(result.askUser, true);
  assert.match(result.message, /看不到/);
});

test('D04 既没有明说也没有默认产品：追问一次', () => {
  const result = pickProduct({ visibleProducts: [{ id: 101 }] });
  assert.equal(result.status, 'ask');
  assert.equal(result.askUser, true);
});

test('D05 随包默认产品：每次使用都要跟用户确认一句', () => {
  const result = pickProduct({
    packageDefault: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }, { id: 102 }],
  });
  assert.equal(result.status, 'package_default');
  assert.equal(result.needsConfirm, true, '随包默认不是用户自己选的，必须确认');
  assert.match(result.message, /对吗/);
});

test('D06 本机默认优先于随包默认，且不再确认', () => {
  const result = pickProduct({
    defaultProduct: { id: 101, name: '示例产品 A' },
    packageDefault: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }, { id: 102 }],
  });
  assert.equal(result.status, 'default');
  assert.equal(result.needsConfirm, undefined, '本机默认是用户自己设的，直接用');
  assert.equal(result.product.id, 101);
});

test('D07 随包默认产品不可见：如实说明并追问，不静默换产品', () => {
  const result = pickProduct({
    packageDefault: { id: 102, name: '示例产品 B' },
    visibleProducts: [{ id: 101 }],
  });
  assert.equal(result.status, 'not_visible');
  assert.equal(result.askUser, true);
  assert.match(result.message, /随包默认/);
});
