// 查询器测试：随包入口脚本（scripts/zentao.mjs）的读子命令在假禅道 API v2 服务上的行为。
// 运行：node --test tests/queryer.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 列表与详情只输出紧凑表格 / 一行 JSON，原始 JSON 不进上下文
//   - 凭据只在脚本进程内使用，不出现在输出里
//   - 没凭据、凭据无效、没装 CLI 时给出可执行的指引，而不是索要密码或回显地址
//
// 迁移说明：旧查询器的 `prep`（一次拿产品+项目+查重候选）与 `check/sync`（宿主 MCP 地址检查）
// 随旧通道一起下线——选品改成显式的 products / projects / dup 三个子命令（本文件 Q03）。
// 旧查询器的 `qd`（产品默认承接人）保留：换成入口脚本的 qd 子命令（Q09-Q13），
// products 的表格里也带上 QD，选品时就能看到。CLI 没装时的指引见 tests/e2e-mock.mjs T16 与本文件 Q07。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MOCK_API_ACCOUNT,
  MOCK_API_ACCOUNTS,
  createMockApiState,
  startMockApi,
} from './mock-zentao-api.mjs';
import { ZentaoEntry, findZentaoCli } from './zentao-client.mjs';

const ZENTAO_CLI = findZentaoCli();
// 入口脚本靠官方禅道 CLI 取数；没装就别假装测过
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它取数，装好再跑这份测试';

const ACCOUNT = MOCK_API_ACCOUNT;
const CRED_VALUE = MOCK_API_ACCOUNTS[ACCOUNT];
const PRODUCT_ID = 101;

function writeCredentials(dir, { account = ACCOUNT, password = CRED_VALUE } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

/** 假服务里的一条反馈（详情字段与真禅道一致）。 */
function seedFeedback(state, id, overrides = {}) {
  state.feedbacks.set(id, {
    id,
    product: PRODUCT_ID,
    title: '既有反馈',
    desc: '',
    type: 'bug',
    status: 'wait',
    assignedTo: '',
    openedBy: ACCOUNT,
    feedbackBy: ACCOUNT,
    actions: [{ id: id * 10, action: 'opened', actor: ACCOUNT, date: '2026-03-04 09:00', comment: '' }],
    ...overrides,
  });
}

/** 假服务里的一条缺陷。 */
function seedBug(state, id, overrides = {}) {
  state.bugs.set(id, {
    id,
    product: PRODUCT_ID,
    title: '既有缺陷',
    steps: '<p>既有正文</p>',
    type: 'codeerror',
    status: 'active',
    severity: '3',
    pri: '3',
    openedBuild: ['trunk'],
    project: 11,
    execution: 0,
    assignedTo: '',
    openedBy: ACCOUNT,
    actions: [{ id: id * 10, action: 'opened', actor: ACCOUNT, date: '2026-03-04 09:00', comment: '' }],
    ...overrides,
  });
}

/**
 * 起假服务 + 隔离的本机配置（凭据、随包配置、本机偏好都落在临时目录）。
 * 入口脚本是子进程；假服务跑在当前进程里，所以必须用异步调用。
 */
async function withMock({ credentials = true, account = ACCOUNT, password = CRED_VALUE, ...overrides }, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-query-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url }));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: credentials ? writeCredentials(dir, { account, password }) : path.join(dir, 'missing'),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
  };
  const zentao = new ZentaoEntry({ env });
  try {
    await fn({ zentao, server, state: server.state, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假服务收到的某条请求次数。 */
function callCount(state, method, pathname) {
  return state.calls.filter((c) => c.method === method && c.path === pathname).length;
}

test('Q01 产品列表：只输出编号、名称与 QD，不回吐原始 JSON', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    const res = await zentao.products();
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.header, /^产品（当前账号可见 2 个；这就是后续选品范围）$/);
    assert.deepEqual(res.rows, [
      { id: 101, name: '示例产品 A', qd: 'mock-qd' },
      { id: 102, name: '示例产品 B', qd: '（空）' },
    ]);
    // 原始 JSON 的痕迹不该进上下文
    assert.ok(!JSON.stringify(res).includes('recTotal'), '输出里不该有原始 JSON 片段');
    // 读一次就够：列表不该被反复翻页
    assert.equal(callCount(state, 'GET', '/api.php/v2/products'), 1);
  });
});

test('Q02 产品列表不做关键词过滤：写错筛选旗标就报用法，不静默按默认值跑', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    // 产品列表始终是「当前账号可见的全部产品」；筛选只发生在单据列表上（bugs/feedbacks --match）
    const res = await zentao.run(['products', '--match', '示例产品 B']);
    assert.equal(res.code, 2, '不认识的旗标要按用法错误退出');
    assert.match(res.stderr, /^错误：用法：/);
    assert.equal(callCount(state, 'GET', '/api.php/v2/products'), 0, '旗标写错时不该发起查询');
  });
});

test('Q03 选品三步：产品 → 项目 → 查重候选，各自都能拿到', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    seedFeedback(state, 100, { title: '设备列表导出无响应' });
    seedBug(state, 900, { title: '设备列表导出按钮点击后无响应' });

    const products = await zentao.products();
    assert.equal(products.rows[0].id, PRODUCT_ID);
    assert.equal(products.rows[0].name, '示例产品 A');

    const projects = await zentao.projects(PRODUCT_ID);
    assert.equal(projects.code, 0, projects.stderr);
    assert.match(projects.header, /^项目（产品 101 下 2 个，其中进行中 1 个）$/);
    assert.deepEqual(projects.rows.map((p) => p.name), ['示例项目 A', '示例项目 B']);

    const dup = await zentao.dup({ kind: 'feedback', product: PRODUCT_ID, title: '导出无响应' });
    assert.equal(dup.code, 0, dup.stderr);
    assert.ok(dup.notes.some((note) => /^查重（产品 101 · 反馈单/.test(note)), '应有查重表头');
    assert.deepEqual(dup.data.candidateIds, [100], '相似标题应作为候选给出');
    assert.deepEqual(dup.data.baseline, [100], '同时给出写入用的查重基线');
  });
});

test('Q04 缺陷详情：字段 + 正文 + 流水都读到，正文已剥掉 HTML 标签', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    seedBug(state, 900, {
      title: '设备列表导出按钮点击后无响应',
      steps: '<p><strong>[步骤]</strong></p><p>1. 打开设备管理</p><p>2. 点导出</p>',
    });

    const { code, data } = await zentao.bug(900);
    assert.equal(code, 0);
    assert.equal(data.ok, true);
    assert.equal(data.id, 900);
    assert.equal(data.title, '设备列表导出按钮点击后无响应');
    assert.match(data.body, /\[步骤\]/);
    assert.ok(!data.body.includes('<p>'), '正文应已剥掉 HTML 标签');
    assert.equal(data.actions[0].action, 'opened');
  });
});

test('Q05 凭据只留在脚本进程内：不进输出、不进报错', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    const res = await zentao.products();
    assert.equal(res.code, 0);
    const printed = `${JSON.stringify(res)}${res.stderr}`;
    assert.ok(!printed.includes(CRED_VALUE), '输出里不该出现密码');
    for (const token of state.tokens.keys()) {
      assert.ok(!printed.includes(token), '输出里不该出现令牌');
    }
  });
});

test('Q06 没有凭据时给出可执行指引，而不是索要密码', { skip: NEEDS_CLI }, async () => {
  await withMock({ credentials: false }, async ({ zentao }) => {
    const res = await zentao.products();
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /set-credentials\.sh/);
    assert.ok(!/密码是|请提供密码|enter password/i.test(res.stderr), '不该向用户索要密码');
  });
});

test('Q07 没装禅道 CLI：报错点名 CLI，且不回显禅道地址', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, server }) => {
    const broken = new ZentaoEntry({ env: { ...env, PATH: path.join(os.tmpdir(), 'rh-no-cli-here') } });
    const res = await broken.products();
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /找不到 zentao 命令/);
    assert.ok(!res.stderr.includes(server.url), '报错里不该出现禅道地址');
  });
});

test('Q08 凭据无效时明确报错，不静默按别的身份读', { skip: NEEDS_CLI }, async () => {
  // 假服务认可的密码换掉：本机凭据里的这份就不对了
  await withMock({ accounts: { [ACCOUNT]: 'another-secret' } }, async ({ zentao, state }) => {
    const res = await zentao.products();
    assert.notEqual(res.code, 0, '凭据无效不该当成成功');
    assert.match(res.stderr, /凭据|锁定/);
    assert.ok(!res.stderr.includes(CRED_VALUE), '报错里不该回显密码');
    assert.equal(callCount(state, 'GET', '/api.php/v2/products'), 0, '不该拿别的身份去读');
  });
});

test('Q09 产品 QD：按编号查到账号、姓名、账号状态与最后登录', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    const res = await zentao.qd(PRODUCT_ID);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.header, /^产品 101 示例产品 A 的默认承接人$/);
    assert.equal(res.fields.QD账号, 'mock-qd');
    assert.equal(res.fields.姓名, '模拟质负');
    assert.equal(res.fields.账号状态, '可用');
    assert.equal(res.fields.最后登录, '2026-10-27 17:21:36');
    // 用户筛选在客户端做：服务端 filters 在这台实例上会被忽略
    assert.equal(callCount(state, 'GET', '/api.php/v2/users'), 1);
  });
});

test('Q10 产品 QD：按名称也能查到（先完全匹配，再按相似度）', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao }) => {
    const res = await zentao.qd('示例产品A');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.header, /^产品 101 示例产品 A 的默认承接人$/);
    assert.equal(res.fields.QD账号, 'mock-qd');
  });
});

test('Q11 产品 QD：产品没配 QD 就说没配，不去查用户表', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state }) => {
    const res = await zentao.qd(102);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.fields.QD账号, '（空）');
    assert.match(res.fields.说明, /该产品没配 QD/);
    assert.equal(callCount(state, 'GET', '/api.php/v2/users'), 0, '没配 QD 时不必查用户表');
  });
});

test('Q12 产品 QD：账号已删除 / 已锁定 / 用户表里查不到，都要如实说', { skip: NEEDS_CLI }, async () => {
  const products = [
    { id: 103, name: '已删 QD 产品', QD: 'mock-qd-deleted' },
    { id: 104, name: '锁定 QD 产品', QD: 'mock-qd-locked' },
    { id: 105, name: '查不到 QD 产品', QD: 'mock-qd-gone' },
  ];
  await withMock({ products }, async ({ zentao }) => {
    const deleted = await zentao.qd(103);
    assert.equal(deleted.fields.姓名, '已删质负');
    assert.equal(deleted.fields.账号状态, '已删除（deleted=1）');

    const locked = await zentao.qd(104);
    assert.equal(locked.fields.姓名, '锁定质负');
    assert.equal(locked.fields.账号状态, '已锁定');

    const gone = await zentao.qd(105);
    assert.equal(gone.fields.姓名, '（禅道用户表里没有这个账号）');
    assert.match(gone.fields.账号状态, /查不到/);
  });
});

test('Q13 产品 QD：产品找不到就列出可见产品，不瞎猜一个', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao }) => {
    const res = await zentao.qd('不存在的产品');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.header, /^没找到产品「不存在的产品」（当前账号可见 2 个/);
    assert.equal(res.fields.QD账号, undefined, '没找到产品时不该给 QD 结论');
    assert.deepEqual(Object.values(res.fields), ['示例产品 A', '示例产品 B'], '把可见产品列出来让人挑');
  });
});
