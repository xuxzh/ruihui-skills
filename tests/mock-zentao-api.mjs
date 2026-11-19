// 本地 mock 的禅道 API v2：复刻官方禅道 CLI 会真的去请求的那套 HTTP 协议，
// 让随包入口脚本可以在没有真实禅道环境时被验证。
//
// 复刻的行为：
//   1. GET /?mode=getconfig 匿名取站点版本，只需站点地址
//   2. POST /api.php/v1/tokens：账号密码对就发一个用户令牌（201），错了 400
//   3. 其余 /api.php/v2/* 请求按请求头 Token 认证；缺令牌或令牌无效 → 401
//   4. 列表接口分页：请求带 pageID / recPerPage，响应带 pager {pageID, recPerPage, recTotal}
//   5. 服务端业务失败是 HTTP 200 + {"status":"fail","message":...}（CLI 会把它变成失败）
//   6. 创建接口无幂等：同一 payload 调两次产生两个 id
//   7. 「保存成功」不等于落库：__NOOP__ 返回成功但记录不存在；更新版是 __NOOP_UPDATE__
//   8. 创建可能超时：__TIMEOUT__ 已落库但不返回响应
//   9. 落库但正文被服务端改写：__ALTERED_DESC__
//
// 场景通过单据标题里的标记注入（沿用旧 mock 的做法）：
//   __FAIL__  __NOOP__  __TIMEOUT__  __NOOP_UPDATE__  __ALTERED_DESC__
// 另有状态注入：loginFails（换令牌一律 400）、tokenFails（API 一律 401）、
// failPaths / hangPaths（按路径注入业务失败或超时）、products / projects（换数据集）。
import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_API_PRODUCTS = [
  { id: 101, name: '示例产品 A', code: 'demo-a', status: 'normal' },
  { id: 102, name: '示例产品 B', code: 'demo-b', status: 'normal' },
];

export const MOCK_API_PROJECTS = [
  { id: 11, name: '示例项目 A', product: 101, status: 'doing' },
  { id: 12, name: '示例项目 B', product: 101, status: 'closed' },
  { id: 13, name: '示例项目 C', product: 102, status: 'doing' },
];

// 服务端一页最多给这么多条；--all 要不要翻页就取决于它和 recTotal
export const MOCK_PAGE_SIZE = 20;

// 假服务认可的账号：测试把它写进本机凭据文件，脚本再拿它换令牌
export const MOCK_API_ACCOUNT = 'mock-user';
export const MOCK_API_ACCOUNTS = { [MOCK_API_ACCOUNT]: 'mock-secret-passphrase' };

export function createMockApiState(overrides = {}) {
  return {
    version: 'max8.2',
    // 禅道认可的账号 → 密码
    accounts: { ...MOCK_API_ACCOUNTS },
    // 令牌 → 账号名（令牌由 POST /api.php/v1/tokens 发出）
    tokens: new Map(),
    // 换过几次令牌、给谁换的（测试用来断言认证走的是账号密码）
    tokenRequests: [],
    products: MOCK_API_PRODUCTS.map((p) => ({ ...p })),
    projects: MOCK_API_PROJECTS.map((p) => ({ ...p })),
    bugs: new Map(),
    feedbacks: new Map(),
    files: new Map(),
    nextBugId: 1900,
    nextFeedbackId: 900,
    nextFileId: 1,
    // 服务端收到的每个请求：{ method, path, query, token, body }
    calls: [],
    // 换令牌一律失败（凭据无效）
    loginFails: false,
    // 任何 API 请求都 401（令牌失效）
    tokenFails: false,
    // 命中的路径返回业务失败 / 不返回响应
    failPaths: [],
    hangPaths: [],
    // 写接口返回成功但不落库（等同于标题带 __NOOP__ 的全局开关）
    noopWrites: false,
    ...overrides,
  };
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function mintToken(state, account) {
  const token = `mock-token-${crypto.randomBytes(8).toString('hex')}`;
  state.tokens.set(token, account);
  return token;
}

// 分页：pageID 从 1 开始，recTotal 给总数（CLI 用 --all 时按它判断要不要翻页）
function paginate(items, query) {
  const pageID = Math.max(1, Number(query.pageID) || 1);
  const recPerPage = Math.min(MOCK_PAGE_SIZE, Math.max(1, Number(query.recPerPage) || MOCK_PAGE_SIZE));
  const start = (pageID - 1) * recPerPage;
  return {
    slice: items.slice(start, start + recPerPage),
    pager: { pageID, recPerPage, recTotal: items.length },
  };
}

function listBody(key, items, query) {
  const { slice, pager } = paginate(items, query);
  return { [key]: slice, pager };
}

function scenarioOf(title) {
  const text = String(title || '');
  for (const marker of ['__FAIL__', '__TIMEOUT__', '__NOOP_UPDATE__', '__NOOP__', '__ALTERED_DESC__']) {
    if (text.includes(marker)) return marker;
  }
  return '';
}

function now() {
  return '2026-11-20 10:00:00';
}

function newRecord(state, account, payload, kind) {
  const id = kind === 'bug' ? state.nextBugId++ : state.nextFeedbackId++;
  return {
    id,
    title: String(payload.title || ''),
    status: 'active',
    openedBy: account,
    openedDate: now(),
    assignedTo: '',
    actions: [{ id: id * 10, action: 'opened', actor: account, date: now(), comment: '' }],
  };
}

// 缺陷单：产品字段叫 productID，正文载体是 steps（富文本），openedBuild 是必填的字符串数组
function createBug(state, account, payload) {
  const marker = scenarioOf(payload.title);
  if (marker === '__FAIL__') return { fail: '『标题』不能为空。' };
  const record = {
    ...newRecord(state, account, payload, 'bug'),
    product: Number(payload.productID) || 0,
    steps: String(payload.steps || ''),
    severity: String(payload.severity || '3'),
    pri: String(payload.pri || '3'),
    type: String(payload.type || 'codeerror'),
    openedBuild: Array.isArray(payload.openedBuild) ? payload.openedBuild : [],
    project: Number(payload.project) || 0,
    execution: Number(payload.execution) || 0,
    assignedTo: String(payload.assignedTo || ''),
  };
  if (marker === '__ALTERED_DESC__') record.steps = '<p>服务端改写过的正文</p>';
  if (marker === '__NOOP__' || state.noopWrites) return { record, persist: false };
  if (marker === '__TIMEOUT__') return { record, persist: true, hang: true };
  return { record, persist: true };
}

function createFeedback(state, account, payload) {
  const marker = scenarioOf(payload.title);
  if (marker === '__FAIL__') return { fail: '『反馈名称』不能为空。' };
  const record = {
    ...newRecord(state, account, payload, 'feedback'),
    product: Number(payload.product) || 0,
    desc: String(payload.desc || ''),
    type: String(payload.type || ''),
    feedbackBy: String(payload.feedbackBy || ''),
  };
  if (marker === '__ALTERED_DESC__') record.desc = '服务端改写过的正文';
  if (marker === '__NOOP__' || state.noopWrites) return { record, persist: false };
  if (marker === '__TIMEOUT__') return { record, persist: true, hang: true };
  return { record, persist: true };
}

// 更新：__NOOP_UPDATE__ 与全局 noopUpdate 都表示「响应成功但没生效」
function updateRecord(state, record, payload, kind) {
  const marker = scenarioOf(record.title) || scenarioOf(payload.title);
  const noop = marker === '__NOOP_UPDATE__' || state.noopUpdate;
  const patched = { ...record };
  if (!noop) {
    if (payload.title !== undefined) patched.title = String(payload.title);
    if (kind === 'bug' && payload.steps !== undefined) patched.steps = String(payload.steps);
    if (kind === 'feedback' && payload.desc !== undefined) patched.desc = String(payload.desc);
    patched.actions = [...record.actions, { id: record.id * 10 + record.actions.length, action: 'edited', actor: 'mock-user', date: now(), comment: '' }];
  }
  return { record: patched, persist: !noop };
}

function matchPath(patterns, pathname) {
  return patterns.includes(pathname);
}

function route(state, req, pathname, query, token, payload) {
  // 站点配置：匿名可读
  if (req.method === 'GET' && query.mode === 'getconfig') {
    return { body: { version: state.version } };
  }

  if (req.method === 'POST' && pathname === '/api.php/v1/tokens') {
    const account = String(payload.account || '');
    const password = String(payload.password || '');
    state.tokenRequests.push({ account });
    if (state.loginFails || state.accounts[account] !== password) {
      return { status: 400, body: { message: '登录失败，请检查您的用户名或密码是否填写正确。' } };
    }
    return { status: 201, body: { token: mintToken(state, account), account } };
  }

  // 以下全部要令牌
  const account = token ? state.tokens.get(token) : undefined;
  if (!token || state.tokenFails || !account) {
    return { status: 401, body: { message: 'Not allowed' } };
  }

  if (matchPath(state.failPaths, pathname)) {
    return { body: { status: 'fail', message: '服务端拒绝了这次请求。' } };
  }
  if (matchPath(state.hangPaths, pathname)) {
    return { hang: true };
  }

  if (req.method === 'GET' && pathname === '/api.php/v2/products') {
    return { body: listBody('products', state.products, query) };
  }
  if (req.method === 'GET' && pathname === '/api.php/v2/projects') {
    return { body: listBody('projects', state.projects, query) };
  }

  let m = pathname.match(/^\/api\.php\/v2\/products\/(\d+)\/bugs$/);
  if (req.method === 'GET' && m) {
    const product = Number(m[1]);
    const items = [...state.bugs.values()].filter((b) => Number(b.product) === product);
    return { body: listBody('bugs', items, query) };
  }

  m = pathname.match(/^\/api\.php\/v2\/bugs\/(\d+)$/);
  if (m) {
    const record = state.bugs.get(Number(m[1]));
    if (req.method === 'GET') return record ? { body: { bug: record } } : { status: 404, body: { message: '记录不存在' } };
    if (req.method === 'PUT') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      const result = updateRecord(state, record, payload, 'bug');
      if (result.persist) state.bugs.set(record.id, result.record);
      return { body: { bug: result.record } };
    }
  }

  if (req.method === 'POST' && pathname === '/api.php/v2/bugs') {
    const result = createBug(state, account, payload);
    if (result.fail) return { body: { status: 'fail', message: result.fail } };
    if (result.persist) state.bugs.set(result.record.id, result.record);
    if (result.hang) return { hang: true };
    return { body: { bug: result.record } };
  }

  m = pathname.match(/^\/api\.php\/v2\/products\/(\d+)\/feedbacks$/);
  if (req.method === 'GET' && m) {
    const product = Number(m[1]);
    const items = [...state.feedbacks.values()].filter((f) => Number(f.product) === product);
    return { body: listBody('feedbacks', items, query) };
  }

  m = pathname.match(/^\/api\.php\/v2\/feedbacks\/(\d+)$/);
  if (m) {
    const record = state.feedbacks.get(Number(m[1]));
    if (req.method === 'GET') return record ? { body: { feedback: record } } : { status: 404, body: { message: '记录不存在' } };
    if (req.method === 'PUT') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      const result = updateRecord(state, record, payload, 'feedback');
      if (result.persist) state.feedbacks.set(record.id, result.record);
      return { body: { feedback: result.record } };
    }
  }

  if (req.method === 'POST' && pathname === '/api.php/v2/feedbacks') {
    const result = createFeedback(state, account, payload);
    if (result.fail) return { body: { status: 'fail', message: result.fail } };
    if (result.persist) state.feedbacks.set(result.record.id, result.record);
    if (result.hang) return { hang: true };
    return { body: { feedback: result.record } };
  }

  if (req.method === 'POST' && pathname === '/api.php/v2/files') {
    const size = Buffer.byteLength(payload.__raw || '');
    const id = state.nextFileId++;
    state.files.set(id, { id, size, addedBy: 'mock-user', addedDate: now() });
    return { body: { file: state.files.get(id) } };
  }

  return { status: 404, body: { message: `mock 没有实现这个路由：${req.method} ${pathname}` } };
}

export function startMockApi(state = createMockApiState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // 禅道的 REST 路径直接把 v2 根挂在 /api.php/v2 下面；站点配置走根路径的 query
    const pathname = url.pathname.replace(/^\/index\.php/, '') || '/';
    const query = Object.fromEntries(url.searchParams.entries());
    const raw = await readBody(req);
    const token = req.headers.token || '';
    let payload = {};
    if (raw) {
      try {
        payload = { ...JSON.parse(raw), __raw: raw };
      } catch {
        payload = { __raw: raw };
      }
    }
    state.calls.push({ method: req.method, path: pathname, query, token, body: raw });

    const result = route(state, req, pathname, query, token, payload);
    if (result.hang) return; // 故意不响应，模拟超时
    return sendJson(res, result.body, result.status || 200);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
