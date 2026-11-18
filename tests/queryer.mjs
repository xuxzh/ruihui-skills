// 查询器测试：随包的 zentao-query.mjs 在 mock MCP 上的行为。
// 运行：node --test tests/
//
// 关注点：
//   - 列表与详情只输出紧凑表格，原始 JSON 不进上下文
//   - 凭据只在脚本进程内使用，不出现在输出里
//   - 查重按关键词给出候选；没有凭据时给出可执行的指引而不是索要密码
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-zentao-mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUERYER = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao-query.mjs');
const CRED_VALUE = 'mock-secret-password';

function writeCredentials(dir) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=mock-user\nZENTAO_PASSWORD=${CRED_VALUE}\n`);
  return file;
}

// 查询器是子进程；mock MCP 跑在当前进程里，所以这里必须用异步的 execFile——
// 同步等待会把当前进程的事件循环卡住，mock 服务就没人应答了。
function runQueryer(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      'node',
      [QUERYER, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function withMock(fn) {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-query-'));
  const credFile = writeCredentials(dir);
  const env = { ZENTAO_MCP_URL: server.url, ZENTAO_CREDENTIALS_FILE: credFile };
  try {
    await fn({ server, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Q01 产品列表：只输出 id 与名称，不回吐原始 JSON', async () => {
  await withMock(async ({ server, env }) => {
    const { code, stdout } = await runQueryer(['products'], { env });
    assert.equal(code, 0);
    assert.match(stdout, /101\t示例产品 A/);
    assert.match(stdout, /102\t示例产品 B/);
    // 原始 JSON 的痕迹不该出现在输出里
    assert.ok(!stdout.includes('"recTotal"'), '输出里不该有原始 JSON 片段');
    assert.ok(!stdout.includes('{'), '输出里不该有原始 JSON 片段');
    // 读一次就够：列表不该被反复翻页
    const listCalls = server.state.calls.filter((c) => c.name === 'get_products');
    assert.equal(listCalls.length, 1);
  });
});

test('Q02 产品列表按关键词过滤：命中中文名，不命中时列出全部可见产品', async () => {
  await withMock(async ({ env }) => {
    const hit = await runQueryer(['products', '--match', '示例产品 B'], { env });
    assert.equal(hit.code, 0);
    assert.match(hit.stdout, /102\t示例产品 B/);
    assert.ok(!hit.stdout.includes('示例产品 A\t'), '不该带出没匹配上的产品');

    const miss = await runQueryer(['products', '--match', '不存在的系统'], { env });
    assert.equal(miss.code, 0);
    assert.match(miss.stdout, /没有匹配/);
    assert.match(miss.stdout, /101\t示例产品 A/, '没匹配上时要把可见产品列出来让人选');
  });
});

test('Q03 prep：一次拿到产品、项目与查重候选', async () => {
  await withMock(async ({ server, env }) => {
    server.state.feedbacks.set('100', {
      id: 100, product: 101, title: '设备列表导出无响应', desc: '', type: 'bug', status: 'wait',
      assignedTo: '', feedbackBy: 'mock', actions: [],
    });
    server.state.bugs.set('900', {
      id: 900, product: 101, title: '设备列表导出按钮点击后无响应', desc: '', type: 'codeerror', status: 'active',
      assignedTo: '', openedBy: 'mock', severity: 3, pri: 3, openedBuild: 'trunk', project: 11, steps: '<p>正文</p>',
      actions: [{ action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' }],
    });

    const { code, stdout } = await runQueryer(['prep', '--product', '示例产品 A', '--match', '导出'], { env });
    assert.equal(code, 0);
    assert.match(stdout, /# 产品 101 示例产品 A/);
    assert.match(stdout, /示例项目 A/);
    assert.match(stdout, /# 缺陷/);
    assert.match(stdout, /900\t设备列表导出按钮点击后无响应/);
    assert.match(stdout, /# 反馈/);
    assert.match(stdout, /100\t设备列表导出无响应/);
    assert.ok(!stdout.includes('"recTotal"'), 'prep 的输出里也不该有原始 JSON');
  });
});

test('Q04 缺陷详情：字段 + 正文 + 流水都读到，正文已剥掉 HTML 标签', async () => {
  await withMock(async ({ server, env }) => {
    server.state.bugs.set('900', {
      id: 900, product: 101, title: '设备列表导出按钮点击后无响应', desc: '', type: 'codeerror', status: 'active',
      assignedTo: '', openedBy: 'mock', severity: 3, pri: 3, openedBuild: 'trunk', project: 11,
      steps: '<p><strong>[步骤]</strong></p><p>1. 打开设备管理</p><p>2. 点导出</p>',
      actions: [{ action: 'opened', actor: 'mock', comment: '', date: '2026-03-04 09:00' }],
    });

    const { code, stdout } = await runQueryer(['bug', '--id', '900'], { env });
    assert.equal(code, 0);
    assert.match(stdout, /# 缺陷 900/);
    assert.match(stdout, /标题\t设备列表导出按钮点击后无响应/);
    assert.match(stdout, /\[步骤\]/);
    assert.match(stdout, /opened\tmock\t2026-03-04 09:00/);
    assert.ok(!stdout.includes('<p>'), '正文应已剥掉 HTML 标签');
  });
});

test('Q05 凭据只留在脚本进程内：不进输出、不进报错', async () => {
  await withMock(async ({ env }) => {
    const { stdout, stderr } = await runQueryer(['products'], { env });
    assert.ok(!stdout.includes(CRED_VALUE), '输出里不该出现密码');
    assert.ok(!stderr.includes(CRED_VALUE), '报错里不该出现密码');
  });
});

test('Q06 没有凭据时给出可执行指引，而不是索要密码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-query-'));
  try {
    const { code, stderr } = await runQueryer(['products'], {
      env: { ZENTAO_MCP_URL: 'http://127.0.0.1:1/mcp', ZENTAO_CREDENTIALS_FILE: path.join(dir, 'missing') },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /set-credentials\.sh/);
    assert.ok(!/密码是|请提供密码|enter password/i.test(stderr), '不该向用户索要密码');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q07 地址检查只给结论，不回显地址', async () => {
  const { code, stdout } = await runQueryer(['check']);
  assert.equal(code, 0);
  assert.match(stdout, /宿主 MCP 地址检查/);
  assert.ok(!/https?:\/\//.test(stdout), '检查结论里不该出现地址');
});
