// 真实 MCP 端到端测试的流程实现：只读自检 → 写入闸门 → 前置自检 → 写入 → 清理 → 结论。
//
// 单独成文件，是为了能在 mock MCP 上验证闸门、前置自检与清理逻辑——
// 这些是写入安全的边界，必须在没有真实禅道环境的情况下也能被测试覆盖。
//
// 写入闸门（三项缺一不可）：
//   1. ZENTAO_E2E_ALLOW_WRITE=1        显式开关
//   2. ZENTAO_E2E_PRODUCT=<产品 id>     目标产品
//   3. ZENTAO_E2E_ALLOWED_PRODUCTS=<id> 允许写入的产品白名单，目标产品必须在里面
// 三项之外还要通过写入前置自检（认证成功、目标产品存在且在白名单内、反馈读取成功）。
// 任一项不满足就停止，不写入。
import { randomUUID } from 'node:crypto';
import { FeedbackAssistant } from './skill-flow.mjs';

export const E2E_MARKER_PREFIX = '[rh-skill-e2e]';

/** 写入闸门：三项条件全部满足才允许写入，否则只读。 */
export function resolveWriteGate(env = {}) {
  const reasons = [];
  const allowWrite = String(env.ZENTAO_E2E_ALLOW_WRITE || '') === '1';
  const productId = String(env.ZENTAO_E2E_PRODUCT || '').trim();
  const allowedProducts = String(env.ZENTAO_E2E_ALLOWED_PRODUCTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowWrite) reasons.push('未设置 ZENTAO_E2E_ALLOW_WRITE=1');
  if (!productId) reasons.push('未设置 ZENTAO_E2E_PRODUCT');
  if (!allowedProducts.length) {
    reasons.push('未设置 ZENTAO_E2E_ALLOWED_PRODUCTS（允许写入的产品白名单）');
  } else if (productId && !allowedProducts.includes(productId)) {
    reasons.push(`产品 #${productId} 不在 ZENTAO_E2E_ALLOWED_PRODUCTS 白名单内`);
  }
  return { allowed: reasons.length === 0, requested: allowWrite, reasons, productId, allowedProducts };
}

/** 本次运行的唯一标识：用于识别「本次创建的测试记录」，清理时只认它。 */
export function buildRunMarker(now = new Date()) {
  return `${E2E_MARKER_PREFIX} ${now.toISOString()}-${randomUUID().slice(0, 8)}`;
}

/** 按唯一标识找出可能属于本次运行的记录。 */
export function findMarkedFeedbacks(feedbacks = [], marker) {
  return feedbacks.filter((f) => typeof f?.title === 'string' && f.title.includes(marker));
}

function describeMessage(data) {
  if (!data) return '未知错误';
  const msg = data.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object') {
    return Object.entries(msg).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join(' | ');
  }
  return String(msg);
}

/**
 * 写入前置自检：认证成功、目标产品存在且属于允许清单、反馈读取成功。
 * 任何一项不通过都不允许写入。
 */
export async function runPreflight({ client, assistant, productId, allowedProducts, record = () => {} }) {
  const steps = [];
  const push = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    record(name, ok, detail);
  };
  try {
    await assistant.login();
    push('前置自检：认证成功', true);
  } catch (err) {
    push('前置自检：认证成功', false, err.message);
    return { ok: false, steps };
  }
  const products = await client.callTool('get_products', { pageID: '1', recPerPage: '100' });
  const list = products.data?.products || [];
  const target = list.find((p) => String(p.id) === String(productId));
  push('前置自检：目标产品存在', !!target, target ? `${target.name}（#${target.id}）` : `#${productId} 不在当前账号可见的产品里`);
  push(
    '前置自检：目标产品在允许清单内',
    allowedProducts.includes(String(productId)),
    `白名单：${allowedProducts.join('、') || '空'}`,
  );
  const feedbacks = await client.callTool('get_products_productID_feedbacks', {
    productID: String(productId), pageID: '1', recPerPage: '20',
  });
  const readOk = feedbacks.status !== 'fail' && !!feedbacks.data;
  push('前置自检：反馈读取成功', readOk, readOk ? '列表可读' : describeMessage(feedbacks.data));
  if (readOk) {
    const items = feedbacks.data?.feedbacks || [];
    if (items.length) {
      const detail = await client.callTool('get_feedbacks_feedbackID', { feedbackID: String(items[0].id) });
      push('前置自检：反馈详情可读', detail.status !== 'fail' && !!detail.data, `#${items[0].id}`);
    } else {
      push('前置自检：反馈详情可读', true, '该产品暂无反馈，跳过详情回读');
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * 端到端流程。返回 { steps, exitCode, gate, marker }。
 * exitCode 非 0 表示整体没有通过（含残留风险）。
 */
export async function runLiveE2E({ client, env = {}, credentials, stamp, log = () => {} }) {
  const steps = [];
  const record = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const finish = () => ({
    steps,
    gate,
    marker,
    exitCode: steps.some((s) => !s.ok) ? 1 : 0,
  });
  const gate = resolveWriteGate(env);
  let marker = null;
  const assistant = new FeedbackAssistant({
    client,
    credentials,
    stamp,
    // 测试环境边界：这里的自动确认只在写入闸门三项条件全部满足时生效。
    // 真实业务会话里没有这个回调——那里的确认由用户完成。
    confirm: async () => {
      if (!gate.allowed) throw new Error('写入闸门未通过，拒绝自动确认写入');
      return true;
    },
  });

  log('\n[只读]');
  try {
    await assistant.login();
    record('登录成功', true);
  } catch (err) {
    record('登录成功', false, err.message);
    return finish();
  }
  const products = await client.callTool('get_products', { pageID: '1', recPerPage: '100' });
  const list = products.data?.products || [];
  record('产品列表可读', list.length > 0, `${list.length} 个产品`);
  const target = gate.productId ? list.find((p) => String(p.id) === gate.productId) : null;
  record('目标产品存在', !gate.productId || !!target, target ? `${target.name}（#${target.id}）` : '未指定 ZENTAO_E2E_PRODUCT');
  const readOnly = await assistant.scanFeedbacks(gate.productId || list[0]?.id);
  record('反馈列表可读', readOnly.complete, readOnly.complete ? `${readOnly.items.length} 条` : readOnly.error);
  if (readOnly.items.length) {
    const detail = await assistant.readBack(readOnly.items[0].id);
    record('反馈详情可读且含 actions[]', detail.found && Array.isArray(detail.raw?.actions), `反馈 #${readOnly.items[0].id}`);
  } else {
    record('反馈详情可读且含 actions[]', true, '该产品暂无反馈，跳过详情回读');
  }

  log('\n[写入]');
  if (!gate.allowed) {
    // 声明了写入意图却没满足安全条件：整体不算通过；只声明只读：按只读跳过。
    const skipped = !gate.requested;
    record(
      '写入闸门',
      skipped,
      skipped
        ? '未设置 ZENTAO_E2E_ALLOW_WRITE=1，只做只读验证'
        : `写入条件不满足（${gate.reasons.join('；')}），已中止写入`,
    );
    return finish();
  }
  const preflight = await runPreflight({
    client, assistant, productId: gate.productId, allowedProducts: gate.allowedProducts, record,
  });
  if (!preflight.ok) {
    record('写入前置自检', false, '前置自检未通过，已中止写入');
    return finish();
  }

  marker = buildRunMarker();
  const title = `${marker} 端到端验证反馈`;
  const desc = '【业务场景】\n技能端到端验证。\n\n【复现步骤】\n1. 无\n\n【实际结果】\n验证用记录，验证后删除。';
  const baseline = (await assistant.scanFeedbacks(gate.productId)).items.length;
  const created = await assistant.submit({ title, desc, type: 'bug', productId: Number(gate.productId) });
  record('创建反馈', created.status === 'created', `status=${created.status} id=${created.id || '-'}`);
  const createdId = created.status === 'created' ? created.id : null;
  if (createdId) {
    const detail = await assistant.readBack(createdId);
    record('创建后回读一致', detail.found && detail.feedback.title === title, `反馈 #${createdId}`);
    const supplemented = await assistant.supplement({ id: createdId, addition: '【补充说明】验证补充路径。' });
    record('补充说明并回读', supplemented.status === 'updated', `status=${supplemented.status}`);
    const after = await assistant.readBack(createdId);
    const kept = after.found && (after.feedback.desc || '').includes('【业务场景】');
    record('补充后保留原文', kept);
  }

  // 创建没拿到原始确认（含超时后靠查询恢复的情况）：按唯一标识复查，报告残留风险。
  const uncertain = !createdId || created.recovered === true;
  let residual = [];
  if (uncertain) {
    const scan = await assistant.scanFeedbacks(gate.productId);
    residual = findMarkedFeedbacks(scan.items, marker);
    if (!scan.complete) {
      record('创建结果确认', false, `创建未拿到原始确认，复查不完整（${scan.error || '未知原因'}），无法确认是否有残留`);
    } else if (residual.length) {
      record('创建结果确认', false, `创建未拿到原始确认，按唯一标识 ${marker} 查到 ${residual.length} 条可能残留记录（${residual.map((f) => `#${f.id}`).join('、')}）`);
    } else {
      record('创建结果确认', false, `创建未拿到原始确认（status=${created.status}），按唯一标识 ${marker} 未查到残留记录；仍需人工核对禅道`);
    }
  }

  // 清理：只处理本次创建、且唯一标识明确匹配到的记录。
  const targets = createdId ? [createdId] : residual.map((f) => f.id);
  for (const id of targets) {
    const del = await client.callTool('delete_feedbacks_feedbackID', { feedbackID: String(id) });
    record('清理测试数据', del.status === 'success' || del.status === undefined, `#${id} status=${del.status}`);
    const after = await assistant.readBack(id);
    record('清理后按 ID 复核不存在', !after.found, `#${id}`);
  }
  const countAfter = (await assistant.scanFeedbacks(gate.productId)).items.length;
  record('条数回到基线（仅辅助证据）', countAfter === baseline, `基线 ${baseline} → 现在 ${countAfter}`);
  return finish();
}
