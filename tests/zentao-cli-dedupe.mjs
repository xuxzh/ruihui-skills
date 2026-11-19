// 查重测试：中文词序不同的标题要能互相命中。
// 运行：node --test tests/zentao-cli-dedupe.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 查重助手把中文标题切成二元组，产出「组内且、组间或」的变体组
//   - 「切换语言功能失效」与「语言切换功能失效」互相命中（ADR-0010 记过的坑）
//   - 只在标题里匹配：正文里出现的词不算命中
//   - 覆盖范围说清是「在你可见的 N 条」，并给出本次扫描的基线 ID
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS, createMockApiState, startMockApi } from './mock-zentao-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts');
const SCRIPT = path.join(SCRIPTS, 'zentao.mjs');
const DEDUPE = path.join(SCRIPTS, 'zentao-dedupe.mjs');
const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本要靠官方禅道 CLI 取数；没装就别假装测过
function findCli() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // 继续找下一个目录
    }
  }
  return '';
}

const NEEDS_CLI = findCli() ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它取数，装好再跑这份测试';

function writeCredentials(dir) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${ACCOUNT}\nZENTAO_PASSWORD=${PASSWORD}\n`);
  return file;
}

// 入口脚本与查重助手都是子进程；假服务跑在当前进程里，所以必须用异步的 execFile
function runNode(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

async function withMock(setup, fn) {
  const state = createMockApiState();
  if (typeof setup === 'function') setup(state);
  const server = await startMockApi(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-dedupe-'));
  const env = { ZENTAO_WEB_URL: server.url, ZENTAO_CREDENTIALS_FILE: writeCredentials(dir) };
  try {
    await fn({ server, env, dir, state });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 查重助手单独跑：打印变体组，一行一个
async function variantGroupsOf(title) {
  const { code, stdout, stderr } = await runNode(DEDUPE, ['--title', title], {});
  assert.equal(code, 0, stderr);
  return stdout
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.trim());
}

// 缺陷单：标题、状态、负责人各不同
function seedBug(state, overrides = {}) {
  const record = {
    id: 1945,
    product: 101,
    title: '语言切换功能失效',
    status: 'active',
    severity: '2',
    pri: '2',
    type: 'codeerror',
    openedBuild: ['trunk'],
    openedBy: 'mock-user',
    openedDate: '2026-03-10 09:00:00',
    assignedTo: 'dev-a',
    steps: '<p>[步骤] 切换语言</p>',
    ...overrides,
  };
  state.bugs.set(record.id, record);
  return record;
}

function seedFeedback(state, overrides = {}) {
  const record = {
    id: 901,
    product: 101,
    title: '语言切换功能失效',
    status: 'wait',
    type: 'advice',
    openedBy: 'mock-user',
    openedDate: '2026-03-11 10:00:00',
    feedbackBy: 'mock-user',
    assignedTo: '',
    desc: '希望语言能记住选择。',
    ...overrides,
  };
  state.feedbacks.set(record.id, record);
  return record;
}

// 查重用的这批单据：两条词序不同的同一条单据 + 一条只在正文里出现查询词的单据 + 两条无关单据
function seedDedupeBugs(state) {
  seedBug(state, { id: 1945, title: '语言切换功能失效', status: 'active', assignedTo: 'dev-a' });
  seedBug(state, { id: 1946, title: '切换语言功能失效', status: 'active', assignedTo: 'dev-b' });
  seedBug(state, {
    id: 1947,
    title: '报表导出按钮点击后无响应',
    status: 'active',
    assignedTo: '',
    steps: '<p>[步骤] 切换语言功能失效时导出也坏了</p>',
  });
  seedBug(state, { id: 1948, title: '页面样式错乱', status: 'active', assignedTo: 'dev-c' });
  seedBug(state, { id: 1949, title: '登录后偶尔掉线', status: 'closed', assignedTo: 'dev-a' });
}

// 输出里的最后一行是给调用方的 JSON 契约（候选、覆盖范围、基线）
function contractOf(stdout) {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('D01 查重助手：中文标题切成二元组，产出「组内且、组间或」的变体组', async () => {
  const groups = await variantGroupsOf('切换语言功能失效');
  // 7 个二元组两两配对 = 21 组，每组两个词（组内且）
  assert.equal(groups.length, 21);
  assert.ok(groups.includes('切换,语言'), `变体组里应有「切换,语言」，实际：${groups.join(' | ')}`);
  for (const group of groups) {
    assert.equal(group.split(',').length, 2, `每组应是两个特征的合取：${group}`);
  }
});

test('D02 查重助手：词序不同的两个标题各自都能命中对方', async () => {
  const forward = await variantGroupsOf('切换语言功能失效');
  const backward = await variantGroupsOf('语言切换功能失效');
  // 「切换」与「语言」都在对方标题里 → 至少有一组两两都在标题里
  const hit = (groups, title) => groups.some((group) => group.split(',').every((term) => title.includes(term)));
  assert.ok(hit(forward, '语言切换功能失效'), '「切换语言功能失效」应命中「语言切换功能失效」');
  assert.ok(hit(backward, '切换语言功能失效'), '「语言切换功能失效」应命中「切换语言功能失效」');
});

test('D03 查重助手：标题太长时改用相邻窗口，组数不随特征数平方增长', async () => {
  const title = '甲乙丙丁戊己庚辛壬癸子丑';
  const groups = await variantGroupsOf(title);
  // 11 个二元组两两配对是 55 组，超出上限 → 退化成相邻窗口（10 组）+ 长度为 3 的滑动窗口（9 组）
  assert.equal(groups.length, 19);
  assert.ok(groups.includes('甲乙,乙丙'), '相邻窗口应保留相邻二元组');
  assert.ok(groups.includes('甲乙,乙丙,丙丁'), '滑动窗口应包含长度为 3 的窗口');
});

test('D04 查重扫描：词序不同的标题互相命中，候选给出编号、标题、状态、负责人', { skip: NEEDS_CLI }, async () => {
  await withMock(seedDedupeBugs, async ({ env }) => {
    const { code, stdout, stderr } = await runNode(
      SCRIPT,
      ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
      env,
    );
    assert.equal(code, 0, stderr);
    // 候选表格：编号、标题、状态、负责人
    assert.match(stdout, /^1945\t语言切换功能失效\tactive\tdev-a\t\d+%$/m);
    assert.match(stdout, /^1946\t切换语言功能失效\tactive\tdev-b\t\d+%$/m);
    // 覆盖范围说清是「在你可见的 N 条」
    assert.match(stdout, /在你可见的 5 条缺陷/);
    const contract = contractOf(stdout);
    assert.equal(contract.ok, true);
    assert.equal(contract.kind, 'bug');
    assert.equal(contract.scanned, 5);
    assert.deepEqual(contract.candidateIds.sort(), [1945, 1946]);
  });
});

test('D05 查重扫描：反过来的词序也命中同一条单据', { skip: NEEDS_CLI }, async () => {
  await withMock(seedDedupeBugs, async ({ env }) => {
    const { code, stdout, stderr } = await runNode(
      SCRIPT,
      ['dup', '--kind', 'bug', '--product', '101', '--title', '语言切换功能失效'],
      env,
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^1946\t切换语言功能失效\tactive\tdev-b\t\d+%$/m);
    assert.match(stdout, /^1945\t语言切换功能失效\tactive\tdev-a\t\d+%$/m);
  });
});

test('D06 查重扫描：正文里出现的词不算命中', { skip: NEEDS_CLI }, async () => {
  await withMock(seedDedupeBugs, async ({ env }) => {
    const { code, stdout, stderr } = await runNode(
      SCRIPT,
      ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
      env,
    );
    assert.equal(code, 0, stderr);
    // #1947 的正文里有查询词，标题里没有 → 不进候选，也不在 CLI 的标题命中里
    assert.doesNotMatch(stdout, /^1947\t/m);
    assert.match(stdout, /在标题里命中 2 条/);
  });
});

test('D07 查重扫描：反馈单也能查，候选与覆盖范围照样给全', { skip: NEEDS_CLI }, async () => {
  await withMock(
    (state) => {
      seedFeedback(state, { id: 901, title: '语言切换功能失效', status: 'wait', assignedTo: '' });
      seedFeedback(state, { id: 902, title: '页面样式错乱', status: 'wait', assignedTo: '' });
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runNode(
        SCRIPT,
        ['dup', '--kind', 'feedback', '--product', '101', '--title', '切换语言功能失效'],
        env,
      );
      assert.equal(code, 0, stderr);
      assert.match(stdout, /^901\t语言切换功能失效\twait\t（未指派）\t\d+%$/m);
      assert.match(stdout, /在你可见的 2 条反馈/);
    },
  );
});

test('D08 查重扫描：没有重复时说清「在你可见的 N 条中未发现重复」', { skip: NEEDS_CLI }, async () => {
  await withMock(
    (state) => {
      seedBug(state, { id: 1948, title: '页面样式错乱' });
      seedBug(state, { id: 1949, title: '登录后偶尔掉线' });
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runNode(
        SCRIPT,
        ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
        env,
      );
      assert.equal(code, 0, stderr);
      assert.match(stdout, /在你可见的 2 条缺陷中未发现重复/);
      const contract = contractOf(stdout);
      assert.deepEqual(contract.candidateIds, []);
    },
  );
});

test('D09 查重扫描：本次扫描的基线是全部单据 ID，基线之外的编号才可能是本次新建', { skip: NEEDS_CLI }, async () => {
  await withMock(seedDedupeBugs, async ({ env }) => {
    const { code, stdout, stderr } = await runNode(
      SCRIPT,
      ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
      env,
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /基线之外的编号才可能是本次新建/);
    const contract = contractOf(stdout);
    assert.deepEqual(contract.baseline.sort((a, b) => a - b), [1945, 1946, 1947, 1948, 1949]);
  });
});

test('D10 查重扫描：选项写错时报用法，不悄悄按默认值跑', { skip: NEEDS_CLI }, async () => {
  await withMock(seedDedupeBugs, async ({ env }) => {
    const { code, stderr } = await runNode(SCRIPT, ['dup', '--kind', 'issue', '--product', '101', '--title', '切换语言'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /错误：/);
  });
});
