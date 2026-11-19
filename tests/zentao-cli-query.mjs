// 入口脚本的单据查询测试：列表与详情在假禅道 API v2 服务上的外部行为。
// 运行：node --test tests/zentao-cli-query.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 列单据是「一次拉全量 + 字段投影 + 客户端筛选」，输出仍是十几行表格，原始 JSON 不进上下文
//   - 打开单据能读到正文（缺陷单剥标签后可与原文逐字比对）、状态、负责人、处理人、处理时间、结论
//   - 操作流水与其中的字段级差异可读，且能区分本次新增的动作与历史动作
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS, createMockApiState, startMockApi } from './mock-zentao-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao.mjs');
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

function writeCredentials(dir, { account = ACCOUNT, password = PASSWORD } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

// 入口脚本是子进程；假服务跑在当前进程里，所以必须用异步的 execFile——
// 同步等待会把当前进程的事件循环卡住，假服务就没人应答了。
function runScript(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

async function withMock(setup, fn) {
  const state = createMockApiState();
  if (typeof setup === 'function') setup(state);
  const server = await startMockApi(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-query-'));
  const env = { ZENTAO_WEB_URL: server.url, ZENTAO_CREDENTIALS_FILE: writeCredentials(dir) };
  try {
    await fn({ server, env, dir, state });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 假服务里的单据：字段名照禅道 REST v2 的原样，steps 是结构化 HTML
function seedBug(state, overrides = {}) {
  const record = {
    id: 1945,
    product: 101,
    title: '切换语言后页面文案仍是中文',
    status: 'active',
    severity: '2',
    pri: '2',
    type: 'codeerror',
    openedBuild: ['trunk'],
    project: 11,
    openedBy: 'mock-user',
    openedDate: '2026-03-10 09:00:00',
    assignedTo: 'dev-a',
    resolvedBy: '',
    resolvedDate: '',
    resolution: '',
    steps: '<p>[步骤] 打开设置 → 切换语言</p><p>[结果] 文案没变</p>',
    actions: [{ id: 1945 * 10, action: 'opened', actor: 'mock-user', date: '2026-03-10 09:00:00', comment: '' }],
    ...overrides,
  };
  state.bugs.set(record.id, record);
  return record;
}

function seedFeedback(state, overrides = {}) {
  const record = {
    id: 901,
    product: 101,
    title: '希望支持导出筛选结果',
    status: 'wait',
    type: 'advice',
    openedBy: 'mock-user',
    openedDate: '2026-03-11 10:00:00',
    feedbackBy: 'mock-user',
    assignedTo: '',
    processedBy: '',
    processedDate: '',
    solution: '',
    desc: '现在只能一页页复制，希望能一键导出。',
    actions: [{ id: 9011, action: 'opened', actor: 'mock-user', date: '2026-03-11 10:00:00', comment: '' }],
    ...overrides,
  };
  state.feedbacks.set(record.id, record);
  return record;
}

// 一批缺陷：标题、状态各不相同，正文里带一个「列表不该搬进上下文」的标记
function seedManyBugs(state, count, { status = () => 'active' } = {}) {
  for (let i = 0; i < count; i++) {
    seedBug(state, {
      id: 1901 + i,
      title: `批量缺陷 ${i + 1}`,
      status: status(i),
      steps: `<p>批量正文 ${i + 1}：列表不该出现的正文</p>`,
    });
  }
}

const listCalls = (server) => server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/'));
const bugListCalls = (server) => server.state.calls.filter((c) => /\/api\.php\/v2\/products\/\d+\/bugs$/.test(c.path));

test('Q01 缺陷列表：投影后的紧凑表格，正文与原始 JSON 不进上下文', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => seedManyBugs(state, 12), async ({ server, env }) => {
    const { code, stdout, stderr } = await runScript(['bugs', '--product', '101'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 缺陷（产品 101 可见 12 条，已扫 12 条，只列前 10 条）$/m);
    assert.match(stdout, /^1901\t批量缺陷 1\tactive\tdev-a\t2\/2$/m);
    // 十几行表格：一行表头 + 默认 10 行
    assert.equal(stdout.trim().split('\n').length, 11, '列表要能一眼看完，不能把上百条倒进上下文');
    // 投影：没选的字段（正文）与原始 JSON 都不该进上下文
    assert.ok(!stdout.includes('列表不该出现的正文'), '正文不在列表的投影字段里');
    assert.ok(!stdout.includes('{'), '输出里不该有原始 JSON 片段');
    assert.ok(!stdout.includes('recTotal'), '输出里不该有原始 JSON 片段');
  });
});

test('Q02 列表：一次拉全量（翻完所有页），筛选在客户端做，不重新请求', { skip: NEEDS_CLI }, async () => {
  // 25 条、其中 15 条 active：一页装不下，必须翻页
  await withMock((state) => seedManyBugs(state, 25, { status: (i) => (i < 15 ? 'active' : 'closed') }), async ({ server, env }) => {
    const { code, stdout, stderr } = await runScript(['bugs', '--product', '101', '--status', 'active'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 缺陷（产品 101 可见 25 条，已扫 25 条，筛选后 15 条，只列前 10 条）$/m);
    assert.match(stdout, /^1901\t批量缺陷 1\tactive/m);
    assert.ok(!stdout.includes('批量缺陷 16'), '状态是 closed 的不该出现');
    // 翻页 = 一次拉全量；筛选不触发第二次扫描
    const pages = bugListCalls(server).map((c) => c.query.pageID);
    assert.deepEqual(pages, ['1', '2'], '应该用 --all 翻完两页');
  });
});

test('Q03 列表 --match 只在标题里筛：正文里的词不算命中', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => {
    seedBug(state, { id: 1951, title: '导出按钮点击无响应', steps: '<p>[步骤] 登录后点导出</p>' });
    seedBug(state, { id: 1952, title: '登录超时', steps: '<p>[步骤] 登录</p>' });
  }, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['bugs', '--product', '101', '--match', '登录'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 缺陷（产品 101 可见 2 条，已扫 2 条，筛选后 1 条）$/m);
    assert.match(stdout, /^1952\t登录超时/m);
    assert.ok(!stdout.includes('导出按钮'), '标题里没有关键词的不该命中');
  });
});

test('Q04 反馈列表：产品下的反馈单紧凑表格，未指派写「（未指派）」', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => {
    seedFeedback(state);
    seedFeedback(state, { id: 902, title: '报表页加载慢', status: 'doing', assignedTo: 'dev-b' });
  }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runScript(['feedbacks', '--product', '101'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 反馈（产品 101 可见 2 条，已扫 2 条）$/m);
    assert.match(stdout, /^901\t希望支持导出筛选结果\twait\t（未指派）$/m);
    assert.match(stdout, /^902\t报表页加载慢\tdoing\tdev-b$/m);
    assert.ok(!stdout.includes('{'), '输出里不该有原始 JSON 片段');
  });
});

test('Q05 缺陷详情：一行 JSON 里读到状态、负责人、处理人、处理时间、结论与正文', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => {
    seedBug(state, {
      id: 1945,
      status: 'resolved',
      assignedTo: 'dev-a',
      resolvedBy: 'dev-a',
      resolvedDate: '2026-03-12 15:30:00',
      resolution: 'fixed',
      steps: '<p>[步骤] 打开设置 → 切换语言</p><p>[结果] 文案没变</p><p>[期望] 文案跟着变</p>',
    });
  }, async ({ server, env }) => {
    const { code, stdout, stderr } = await runScript(['bug', '--id', '1945'], env);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim().split('\n').length, 1, '详情是一行 JSON');
    const detail = JSON.parse(stdout.trim());
    assert.equal(detail.ok, true);
    assert.equal(detail.kind, 'bug');
    assert.equal(detail.id, 1945);
    assert.equal(detail.product, 101);
    assert.equal(detail.status, 'resolved');
    assert.equal(detail.assignee, 'dev-a');
    assert.equal(detail.processor, 'dev-a');
    assert.equal(detail.processedDate, '2026-03-12 15:30:00');
    assert.equal(detail.resolution, 'fixed');
    assert.equal(detail.openedBy, 'mock-user');
    // 详情也只要读一次，不翻页
    assert.equal(bugListCalls(server).length, 0, '按 ID 打开单据不该去拉列表');
    assert.equal(server.state.calls.filter((c) => c.path === '/api.php/v2/bugs/1945').length, 1);
  });
});

test('Q06 缺陷正文剥标签后可与原文逐字比对', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => {
    seedBug(state, {
      id: 1960,
      steps: '<p>[步骤] 打开设置 &nbsp;切换语言</p><p>[结果] 文案<br>没变</p><p>[期望] &amp; 文案跟着变</p>',
    });
  }, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['bug', '--id', '1960'], env);
    assert.equal(code, 0, stderr);
    const { body } = JSON.parse(stdout.trim());
    // 同一份内容按纯文本写进草稿时的形态
    const expected = '[步骤] 打开设置 切换语言\n[结果] 文案\n没变\n[期望] & 文案跟着变';
    assert.equal(body, expected);
  });
});

test('Q07 反馈详情：正文取 desc，评审人、处理人、处理时间与结论取自反馈单字段', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => {
    seedFeedback(state, {
      id: 901,
      status: 'toclosed',
      assignedTo: 'dev-c',
      reviewedBy: 'pm-a',
      reviewedDate: '2026-03-12 10:00:00',
      processedBy: 'dev-c',
      processedDate: '2026-03-13 09:10:00',
      solution: '已排入下个迭代',
    });
  }, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['feedback', '--id', '901'], env);
    assert.equal(code, 0, stderr);
    const detail = JSON.parse(stdout.trim());
    assert.equal(detail.kind, 'feedback');
    assert.equal(detail.status, 'toclosed');
    assert.equal(detail.assignee, 'dev-c');
    assert.equal(detail.reviewer, 'pm-a');
    assert.equal(detail.reviewedDate, '2026-03-12 10:00:00');
    assert.equal(detail.processor, 'dev-c');
    assert.equal(detail.processedDate, '2026-03-13 09:10:00');
    assert.equal(detail.resolution, '已排入下个迭代');
    assert.equal(detail.body, '现在只能一页页复制，希望能一键导出。');
  });
});

test('Q08 流水：字段级差异可读，基线之外的动作标成本次新增', { skip: NEEDS_CLI }, async () => {
  const actions = [
    { id: 19451, action: 'opened', actor: 'mock-user', date: '2026-03-10 09:00:00', comment: '' },
    {
      id: 19452,
      action: 'resolved',
      actor: 'dev-a',
      date: '2026-03-12 15:30:00',
      comment: '已修复',
      history: [
        { field: 'status', old: 'active', new: 'resolved' },
        { field: 'resolvedBy', old: '', new: 'dev-a' },
      ],
    },
  ];
  await withMock((state) => seedBug(state, { id: 1945, status: 'resolved', actions }), async ({ env }) => {
    // 写前读到的动作 ID 就是基线
    const before = await runScript(['bug', '--id', '1945', '--baseline-actions', '19451'], env);
    assert.equal(before.code, 0, before.stderr);
    const detail = JSON.parse(before.stdout.trim());
    assert.deepEqual(detail.actions.map((a) => a.id), [19451, 19452]);
    assert.equal(detail.actions[0].new, false, '基线里的动作是历史动作');
    assert.equal(detail.actions[1].new, true, '基线之外的动作是本次新增');
    assert.deepEqual(detail.actions[0].changes, [], '没改字段的动作没有字段级差异');
    assert.deepEqual(detail.actions[1].changes, [
      { field: 'status', from: 'active', to: 'resolved' },
      { field: 'resolvedBy', from: '（空）', to: 'dev-a' },
    ]);
    assert.equal(detail.actions[1].comment, '已修复');
    assert.equal(detail.actions[1].actor, 'dev-a');
    assert.equal(detail.actions[1].date, '2026-03-12 15:30:00');
  });
});

test('Q09 没给基线：输出里没有 new 字段，分不出就不是新增', { skip: NEEDS_CLI }, async () => {
  await withMock((state) => seedBug(state, { id: 1945 }), async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['bug', '--id', '1945'], env);
    assert.equal(code, 0, stderr);
    const detail = JSON.parse(stdout.trim());
    assert.equal(detail.actions.length, 1);
    assert.ok(!('new' in detail.actions[0]), '没有基线时不能凭空说哪条是本次新增');
  });
});

test('Q10 参数写错：给用法提示并退出码 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock(() => {}, async ({ server, env }) => {
    const noProduct = await runScript(['bugs'], env);
    assert.equal(noProduct.code, 2);
    assert.match(noProduct.stderr, /^错误：用法：/);

    const badProduct = await runScript(['bugs', '--product', '报表平台'], env);
    assert.equal(badProduct.code, 2);
    assert.match(badProduct.stderr, /产品 ID 是数字/);

    const noId = await runScript(['bug'], env);
    assert.equal(noId.code, 2);
    assert.match(noId.stderr, /--id <单据ID>/);

    const badBaseline = await runScript(['bug', '--id', '1945', '--baseline-actions', 'abc'], env);
    assert.equal(badBaseline.code, 2);
    assert.match(badBaseline.stderr, /--baseline-actions 只认动作 ID/);

    const typo = await runScript(['bugs', '--product', '101', '--state', 'active'], env);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /bugs 不认这些选项：--state/);

    assert.equal(listCalls(server).length, 0, '参数不对时不该查禅道');
  });
});

test('Q11 单据不存在：退出码非 0，错误可读，stdout 是 ok:false', { skip: NEEDS_CLI }, async () => {
  await withMock(() => {}, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['bug', '--id', '9999'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
  });
});

// 一批反馈：超过一页（假服务每页 20 条），逼出翻页
function seedManyFeedbacks(state, count) {
  for (let i = 0; i < count; i++) {
    seedFeedback(state, { id: 901 + i, title: `批量反馈 ${i + 1}` });
  }
}

const feedbackListCalls = (server) =>
  server.state.calls.filter((c) => /\/api\.php\/v2\/products\/\d+\/feedbacks$/.test(c.path));

test('Q12 服务端分页不前进：列表不整体失败，退回第 1 页并注明覆盖不完整', { skip: NEEDS_CLI }, async () => {
  // 复刻真实 max 8.2 实例：产品 101 的反馈列表从第 2 页起返回空集、pageID 钳回 1
  await withMock(
    (state) => {
      seedManyFeedbacks(state, 25);
      state.pagingStuckProducts = [101];
    },
    async ({ server, env }) => {
      const { code, stdout, stderr } = await runScript(['feedbacks', '--product', '101'], env);
      assert.equal(code, 0, stderr);
      // 表头必须让人一眼看出这次扫描是不完整的，并且不能说成「全部」
      assert.match(
        stdout,
        /^# 反馈（产品 101 扫到 20 条，服务端称共有 25 条，服务端分页未向前推进，覆盖不完整，只列前 10 条）$/m,
      );
      // 第 1 页的记录照常返回，不是空表
      assert.match(stdout, /^901\t批量反馈 1\t/m);
      assert.ok(!stdout.includes('{'), '输出里不该有原始 JSON 片段');
      // 请求轨迹：翻到第 2 页才失败，然后退回第 1 页重读
      assert.deepEqual(feedbackListCalls(server).map((c) => c.query.pageID), ['1', '2', '1']);
    },
  );
});

test('Q13 同一页内容重复：同样退回第 1 页，覆盖范围同样注明不完整', { skip: NEEDS_CLI }, async () => {  // CLI 的另一条分页保护：相邻两页内容一模一样（同样报 E2008「服务端分页未向前推进」）
  await withMock(
    (state) => {
      seedManyFeedbacks(state, 25);
      state.pagingRepeatProducts = [101];
    },
    async ({ server, env }) => {
      const { code, stdout, stderr } = await runScript(['feedbacks', '--product', '101'], env);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /^# 反馈（产品 101 扫到 20 条，服务端称共有 25 条，服务端分页未向前推进，覆盖不完整/m);
      assert.match(stdout, /^901\t批量反馈 1\t/m);
      assert.deepEqual(feedbackListCalls(server).map((c) => c.query.pageID), ['1', '2', '1']);
    },
  );
});

test('Q14 服务端返回别的产品的记录：归属校验丢掉，并在表头点名', { skip: NEEDS_CLI }, async () => {
  // 复刻真实实例的另一个怪象：请求产品 101 的反馈列表，回来的记录 product 字段是 102
  await withMock(
    (state) => {
      seedFeedback(state, { id: 951, product: 102, title: '属于产品 102 的反馈' });
      seedFeedback(state, { id: 952, product: 102, title: '另一条产品 102 的反馈' });
      state.foreignProductLists = { 101: 102 };
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runScript(['feedbacks', '--product', '101'], env);
      assert.equal(code, 0, stderr);
      assert.match(
        stdout,
        /^# 反馈（产品 101 扫到 0 条，禅道返回的 2 条记录 product 字段是 102，不属于产品 101，已丢弃）$/m,
      );
      assert.ok(!stdout.includes('属于产品 102 的反馈'), '别的产品的记录不能当成本产品的列出来');
    },
  );
});
