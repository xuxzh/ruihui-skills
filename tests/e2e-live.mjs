// 第二层测试（真实端到端）：对着真实禅道跑技能的读写流程。
//
// 通道与技能实际路径一致：入口脚本（scripts/zentao.mjs）→ 官方禅道 CLI → 禅道实例。
//
// 用法（凭据来自环境变量或仓库根目录 .env）：
//   node tests/e2e-live.mjs                     # 只读验证
//   ZENTAO_E2E_ALLOW_WRITE=1 \
//   ZENTAO_E2E_PRODUCT=<产品 id> \
//   ZENTAO_E2E_ALLOWED_PRODUCTS=<产品 id,...> \
//     node tests/e2e-live.mjs                   # 允许在白名单产品内写入并清理
//
// 写入保护（ADR-0003，三道闸门写在仓库根 .env，代码只读环境变量）：
//   - 必须显式设置 ZENTAO_E2E_ALLOW_WRITE=1
//   - 必须显式设置 ZENTAO_E2E_PRODUCT=<产品 id>
//   - 必须显式设置 ZENTAO_E2E_ALLOWED_PRODUCTS=<允许写入的产品 id 白名单>，且目标产品在白名单内
//   - 写入前还要通过前置自检：认证成功、目标产品存在、反馈读取成功；任一项不满足立即中止
//   - 测试数据带 [rh-skill-e2e] 唯一标识，清理只处理本次创建且标识明确匹配的记录，
//     删除后再按 ID 回读，确认记录确已消失
//   - 创建超时/结果不明时按唯一标识复查，报告残留风险并以非零退出码结束
//
// 流程实现见 tests/e2e-live-flow.mjs；闸门与清理逻辑在假禅道 API 上有测试覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ZentaoEntry } from './zentao-client.mjs';
import { runLiveE2E, runLiveBugE2E } from './e2e-live-flow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(path.join(ROOT, '.env'));

// 站点地址：.env 里既可以写 ZENTAO_WEB_URL，也可以写 ZENTAO_BASE_URL（禅道 Web 根地址）
const site = String(env.ZENTAO_WEB_URL || env.ZENTAO_BASE_URL || '').replace(/\/+$/, '');
if (!site) {
  console.error('缺少 ZENTAO_WEB_URL（或 ZENTAO_BASE_URL）：无法运行真实端到端测试');
  process.exit(2);
}

// 凭据：优先用显式指定的凭据文件；否则把 .env 里的账号密码写进临时凭据文件，跑完删掉。
let credentialsFile = env.ZENTAO_CREDENTIALS_FILE || '';
let tempDir = '';
if (!credentialsFile) {
  const account = String(env.ZENTAO_ACCOUNT || '');
  const secret = String(env.ZENTAO_TOKEN || env.ZENTAO_PASSWORD || '');
  if (!account || !secret) {
    console.error('缺少 ZENTAO_ACCOUNT 与 ZENTAO_TOKEN（或 ZENTAO_PASSWORD）：写进仓库根 .env，不要提交');
    process.exit(2);
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-e2e-live-'));
  credentialsFile = path.join(tempDir, 'credentials');
  const lines = [`ZENTAO_ACCOUNT=${account}`, env.ZENTAO_TOKEN ? `ZENTAO_TOKEN=${env.ZENTAO_TOKEN}` : `ZENTAO_PASSWORD=${env.ZENTAO_PASSWORD}`];
  fs.writeFileSync(credentialsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const zentao = new ZentaoEntry({
  env: { ...env, ZENTAO_WEB_URL: site, ZENTAO_CREDENTIALS_FILE: credentialsFile },
  timeoutMs: 600000,
});
const stamp = () => new Date().toISOString().slice(0, 10);
const log = (line) => console.log(line);

try {
  // 两条写入闭环共用同一套闸门与唯一标识；各自清理各自创建的记录。
  const feedbackRun = await runLiveE2E({ zentao, env, stamp, log, image: true });
  const bugRun = await runLiveBugE2E({ zentao, env, stamp, log, image: true });
  const steps = [...feedbackRun.steps, ...bugRun.steps];
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n合计 ${steps.length} 项，通过 ${steps.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
