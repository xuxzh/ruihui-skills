// 第二层测试（真实 MCP 端到端）：对着真实禅道 MCP 跑技能的读写流程。
//
// 用法（凭据来自环境变量或仓库根目录 .env）：
//   node tests/e2e-live.mjs                     # 只读验证
//   ZENTAO_E2E_ALLOW_WRITE=1 node tests/e2e-live.mjs   # 允许在指定产品内写入并清理
//
// 写入保护：
//   - 必须显式设置 ZENTAO_E2E_ALLOW_WRITE=1
//   - 必须显式设置 ZENTAO_E2E_PRODUCT=<产品 id>
//   - 测试数据带 [rh-skill-e2e] 前缀，验证后删除，并核对条数回到基线
import { McpClient, loadEnv } from './mcp-client.mjs';
import { FeedbackAssistant } from './skill-flow.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(path.join(ROOT, '.env'));

const url = env.ZENTAO_MCP_URL;
const productId = env.ZENTAO_E2E_PRODUCT;
const allowWrite = env.ZENTAO_E2E_ALLOW_WRITE === '1';

if (!url) {
  console.error('缺少 ZENTAO_MCP_URL：无法运行真实端到端测试');
  process.exit(2);
}

const steps = [];
const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const client = new McpClient(url, { timeoutMs: 20000 });
await client.initialize();

const assistant = new FeedbackAssistant({
  client,
  confirm: async () => true,
  credentials: { account: env.ZENTAO_ACCOUNT || '', password: env.ZENTAO_PASSWORD || '' },
  stamp: () => new Date().toISOString().slice(0, 10),
});

console.log('\n[只读]');
try {
  await assistant.login();
  record('登录成功', true);

  const products = await client.callTool('get_products', { recPerPage: '100' });
  const list = products.data?.products || [];
  record('产品列表可读', list.length > 0, `${list.length} 个产品`);

  const target = productId ? list.find((p) => String(p.id) === String(productId)) : null;
  record('目标产品存在', !productId || !!target, target ? `${target.name}（#${target.id}）` : '未指定 ZENTAO_E2E_PRODUCT');

  const feedbacks = await assistant.listFeedbacks(productId || list[0]?.id);
  record('反馈列表可读', Array.isArray(feedbacks), `${feedbacks.length} 条`);

  if (feedbacks.length) {
    const detail = await assistant.readBack(feedbacks[0].id);
    record('反馈详情可读且含 actions[]', detail.found && Array.isArray(detail.raw?.actions), `反馈 #${feedbacks[0].id}`);
  } else {
    record('反馈详情可读且含 actions[]', true, '该产品暂无反馈，跳过详情回读');
  }
} catch (err) {
  record('只读流程', false, err.message);
}

console.log('\n[写入]');
if (!allowWrite) {
  console.log('  skip 未设置 ZENTAO_E2E_ALLOW_WRITE=1，跳过写入验证');
} else if (!productId) {
  console.log('  skip 未设置 ZENTAO_E2E_PRODUCT，跳过写入验证');
} else {
  const marker = `[rh-skill-e2e] ${new Date().toISOString()}`;
  const title = `${marker} 端到端验证反馈`;
  const desc = '【业务场景】\n技能端到端验证。\n\n【复现步骤】\n1. 无\n\n【实际结果】\n验证用记录，验证后删除。';
  const baseline = (await assistant.listFeedbacks(productId)).length;
  let createdId = null;
  try {
    const created = await assistant.submit({ title, desc, type: 'bug', productId: Number(productId) });
    record('创建反馈', created.status === 'created', `status=${created.status} id=${created.id || '-'}`);
    createdId = created.id;

    if (createdId) {
      const detail = await assistant.readBack(createdId);
      record('创建后回读一致', detail.found && detail.feedback.title === title, `反馈 #${createdId}`);

      const supplemented = await assistant.supplement({ id: createdId, addition: '【补充说明】验证补充路径。' });
      record('补充说明并回读', supplemented.status === 'updated', `status=${supplemented.status}`);

      const after = await assistant.readBack(createdId);
      const kept = after.found && (after.feedback.desc || '').includes('【业务场景】');
      record('补充后保留原文', kept);
    }
  } catch (err) {
    record('写入流程', false, err.message);
  } finally {
    if (createdId) {
      const del = await client.callTool('delete_feedbacks_feedbackID', { feedbackID: String(createdId) });
      record('清理测试数据', del.status === 'success' || del.status === undefined, `status=${del.status}`);
    }
    const after = (await assistant.listFeedbacks(productId)).length;
    record('条数回到基线', after === baseline, `基线 ${baseline} → 现在 ${after}`);
  }
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n合计 ${steps.length} 项，通过 ${steps.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
