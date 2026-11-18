// 第二层测试（真实 MCP 端到端）：对着真实禅道 MCP 跑技能的读写流程。
//
// 用法（凭据来自环境变量或仓库根目录 .env）：
//   node tests/e2e-live.mjs                     # 只读验证
//   ZENTAO_E2E_ALLOW_WRITE=1 \
//   ZENTAO_E2E_PRODUCT=<产品 id> \
//   ZENTAO_E2E_ALLOWED_PRODUCTS=<产品 id,...> \
//     node tests/e2e-live.mjs                   # 允许在白名单产品内写入并清理
//
// 写入保护：
//   - 必须显式设置 ZENTAO_E2E_ALLOW_WRITE=1
//   - 必须显式设置 ZENTAO_E2E_PRODUCT=<产品 id>
//   - 必须显式设置 ZENTAO_E2E_ALLOWED_PRODUCTS=<允许写入的产品 id 白名单>，且目标产品在白名单内
//   - 写入前还要通过前置自检：认证成功、目标产品存在、反馈读取成功；任一项不满足立即中止
//   - 测试数据带 [rh-skill-e2e] 唯一标识，清理只处理本次创建且标识明确匹配的记录
//   - 创建超时/结果不明时按唯一标识复查，报告残留风险并以非零退出码结束
//
// 流程实现见 tests/e2e-live-flow.mjs；闸门与清理逻辑在 mock MCP 上有测试覆盖。
import { McpClient, loadEnv } from './mcp-client.mjs';
import { runLiveE2E, runLiveBugE2E } from './e2e-live-flow.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(path.join(ROOT, '.env'));
const url = env.ZENTAO_MCP_URL;
if (!url) {
  console.error('缺少 ZENTAO_MCP_URL：无法运行真实端到端测试');
  process.exit(2);
}
const client = new McpClient(url, { timeoutMs: 20000 });
await client.initialize();
const credentials = { account: env.ZENTAO_ACCOUNT || '', password: env.ZENTAO_PASSWORD || '' };
const stamp = () => new Date().toISOString().slice(0, 10);
const log = (line) => console.log(line);

// 两条写入闭环共用同一套闸门与唯一标识；各自清理各自创建的记录。
// 图片闭环要直连禅道 REST v2，只有配了真实禅道端点时才跑。
const image = Boolean(env.ZENTAO_BASE_URL && env.ZENTAO_MCP_URL);
const feedbackRun = await runLiveE2E({ client, env, credentials, stamp, log, image });
const bugRun = await runLiveBugE2E({ client, env, credentials, stamp, log, image });
const steps = [...feedbackRun.steps, ...bugRun.steps];
const failed = steps.filter((s) => !s.ok);
console.log(`\n合计 ${steps.length} 项，通过 ${steps.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
