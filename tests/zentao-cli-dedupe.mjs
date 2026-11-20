import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENTRY_SCRIPT, findZentaoCli, runEntryScript, runScript, withMockApi } from './zentao-client.mjs';

const SCRIPTS = path.dirname(ENTRY_SCRIPT);
const DEDUPE = path.join(SCRIPTS, 'zentao-dedupe.mjs');

const NEEDS_CLI = findZentaoCli() ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它取数，装好再跑这份测试';

/** 起假服务 + 隔离的本机凭据；setup 往状态里塞单据。 */
const withMock = (setup, fn) => withMockApi({ tag: 'rh-cli-dedupe', seed: setup }, fn);

// 查重助手单独跑：打印变体组，一行一个
async function variantGroupsOf(title) {
  const { code, stdout, stderr } = await runScript(DEDUPE, ['--title', title], {});
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
    const { code, stdout, stderr } = await runEntryScript(
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
    const { code, stdout, stderr } = await runEntryScript(
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
    const { code, stdout, stderr } = await runEntryScript(
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
      const { code, stdout, stderr } = await runEntryScript(
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
      const { code, stdout, stderr } = await runEntryScript(
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
    const { code, stdout, stderr } = await runEntryScript(
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
    const { code, stderr } = await runEntryScript( ['dup', '--kind', 'issue', '--product', '101', '--title', '切换语言'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /错误：/);
  });
});

// 超过一页（假服务每页 20 条）的缺陷：逼出翻页
test('D11 服务端分页不前进：查重不谎报「未发现重复」，而是说清覆盖不完整', { skip: NEEDS_CLI }, async () => {
  await withMock(
    (state) => {
      seedBug(state, { id: 1945, title: '语言切换功能失效', status: 'active', assignedTo: 'dev-a' });
      seedBug(state, { id: 1946, title: '切换语言功能失效', status: 'active', assignedTo: 'dev-b' });
      for (let i = 0; i < 23; i++) seedBug(state, { id: 2000 + i, title: `无关缺陷 ${i + 1}` });
      state.pagingStuckProducts = [101];
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(
        ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
        env,
      );
      assert.equal(code, 0, stderr);
      // 不能把第 1 页当全部：「在你可见的 N 条中未发现重复」这种说法不许出现
      assert.doesNotMatch(stdout, /在你可见的 \d+ 条/);
      assert.match(stdout, /覆盖不完整/);
      assert.match(stdout, /只扫到 20 条缺陷，服务端称共有 25 条，服务端分页未向前推进/);
      assert.match(stdout, /不等于全部可见记录里没有/);
      // 基线也不完整，不能拿它判断哪些是本次新建
      assert.match(stdout, /基线不完整/);
      // 第 1 页里命中的候选照常列出
      assert.match(stdout, /^1945\t语言切换功能失效\tactive\tdev-a\t\d+%$/m);
      const contract = contractOf(stdout);
      assert.equal(contract.complete, false);
      assert.equal(contract.scanned, 20);
      assert.equal(contract.total, 25);
      assert.ok(contract.baseline.length > 0, '拿到的第 1 页编号仍要给出');
    },
  );
});

test('D12 服务端返回别的产品的记录：不算进覆盖范围，也不进基线', { skip: NEEDS_CLI }, async () => {
  await withMock(
    (state) => {
      // 请求产品 101 的缺陷列表，回来的却是产品 102 的记录（复刻真实实例的怪象）
      seedBug(state, { id: 1945, product: 102, title: '语言切换功能失效' });
      seedBug(state, { id: 1946, product: 102, title: '切换语言功能失效' });
      state.foreignProductLists = { 101: 102 };
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(
        ['dup', '--kind', 'bug', '--product', '101', '--title', '切换语言功能失效'],
        env,
      );
      assert.equal(code, 0, stderr);
      // 别的产品的记录不能算成本产品的候选，也不能撑起「在你可见的 N 条」这种说法
      assert.doesNotMatch(stdout, /在你可见的 \d+ 条/);
      assert.match(stdout, /^# 覆盖范围：在这 0 条缺陷中未发现重复/m);
      assert.match(stdout, /不属于产品 101，已丢弃/);
      assert.match(stdout, /基线不完整/);
      const contract = contractOf(stdout);
      assert.equal(contract.complete, false);
      assert.equal(contract.foreignRecords, 2);
      assert.deepEqual(contract.baseline, []);
    },
  );
});
