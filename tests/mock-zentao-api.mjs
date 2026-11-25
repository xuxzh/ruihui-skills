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
//  10. 产品的默认承接人（qd）：建单不指定负责人时按产品 QD 指派，显式空字符串则挡住
//
// 场景通过单据标题里的标记注入（沿用旧 mock 的做法）：
//   __FAIL__  __NOOP__  __TIMEOUT__  __NOOP_UPDATE__  __ALTERED_DESC__
// 另有状态注入：loginFails（换令牌一律 400）、tokenFails（API 一律 401）、
// failPaths / hangPaths（按路径注入业务失败或超时）、products / projects（换数据集）、
// visibleProducts（按账号限定可见产品）、createHang（'ghost' / 'persist'）、
// noopWrites / noopUpdate（写接口返回成功但不落库/不生效）、deleteFails（删除一律失败）、
// pagingStuckProducts / pagingRepeatProducts（产品列表的分页缺陷，见 createMockApiState）。
import http from 'node:http';
import crypto from 'node:crypto';

// QD 是产品默认承接人：建单不指定负责人时，禅道会指派给他（ADR-0016 / ADR-0018 的语义）。
// 字段名与真禅道一致：大写 QD（小写 qd 不是合法字段名，会被投影忽略）。
export const MOCK_API_PRODUCTS = [
  { id: 101, name: '示例产品 A', code: 'demo-a', status: 'normal', QD: 'mock-qd' },
  { id: 102, name: '示例产品 B', code: 'demo-b', status: 'normal', QD: '' },
];

// 用户表：产品 QD 指向的账号及它的软失效标记（deleted / locked）与最后登录
export const MOCK_API_USERS = [
  { account: 'mock-qd', realname: '模拟质负', deleted: '0', locked: '', last: '2026-10-27 17:21:36' },
  { account: 'mock-qd-deleted', realname: '已删质负', deleted: '1', locked: '', last: '2025-01-02 09:00:00' },
  { account: 'mock-qd-locked', realname: '锁定质负', deleted: '0', locked: '1', last: '2025-06-01 08:00:00' },
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
    users: MOCK_API_USERS.map((u) => ({ ...u })),
    projects: MOCK_API_PROJECTS.map((p) => ({ ...p })),
    bugs: new Map(),
    feedbacks: new Map(),
    files: new Map(),
    // 删掉的附件留个底（挂载对象在这），测试好回查图片附件挂在哪张单据上
    deletedFiles: new Map(),
    // 反馈列表第一次请求返回全局记录，第二次起才按产品过滤（复刻真实 max 8.2：
    // 同一个令牌的第一次 feedbacks 请求会忽略 productID，第二次才生效）
    feedbackFirstListGlobal: false,
    feedbackListSeen: new Set(),
    // 反馈正文里的 <img> 落库时被服务端补 onload（真实实例行为），用来验证正文归一化
    feedbackImageOnload: false,
    // 缺陷正文里的 <img> 落库时被服务端吃掉，用来验证回读核对能发现图片引用丢失
    bugStepsDropImage: false,
    // 缺陷正文里的 <img> 落库时被服务端补 onload（真实实例行为），用来验证正文归一化
    bugStepsOnload: false,
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
    // 更新接口返回成功但不生效（等同于标题带 __NOOP_UPDATE__ 的全局开关）
    noopUpdate: false,
    // 回读不返回操作流水（复刻真实 CLI 0.4.4：API 有 actions，但 CLI 的 get 不映射这个字段）
    omitActions: false,
    // 创建接口挂住不返回：'ghost' = 没落库，'persist' = 已落库（等同标题带 __TIMEOUT__）
    createHang: '',
    // 删除接口一律业务失败（模拟没有删除权限）
    deleteFails: false,
    // 允许直接关闭 active 状态的缺陷（默认拒绝，复刻多数禅道工作流「先解决再关闭」）
    allowCloseActiveBug: false,
    // 命中这些动作名（resolve / close / activate）的流转返回成功但不改状态（复刻静默失败）
    noopTransitions: [],
    // 这些产品的列表接口从第 2 页起返回空集，并把 pageID 钳回 1（复刻真实 max 8.2 实例的反馈列表：
    // CLI 的 --all 保护会报 E2008「服务端分页未向前推进」，整条读取失败）
    pagingStuckProducts: [],
    // 这些产品的列表接口从第 2 页起原样返回第 1 页（同一页内容重复，CLI 报同一条 E2008）
    pagingRepeatProducts: [],
    // 请求这个产品的列表，服务端却返回另一个产品的记录（复刻真实实例：请求产品 29 的反馈列表，
    // 回来的记录 product 字段是 1）——入口脚本靠 product 字段做归属校验，不能当成本产品的记录
    foreignProductLists: {},
    // 账号 → 可见产品：给了就按它过滤产品列表与写入目标
    visibleProducts: null,
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

/** multipart 表单里取一个字段的值（官方 CLI 的附件上传用 formdata 提交）。 */
function multipartField(raw, name) {
  const matched = String(raw || '').match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`));
  return matched ? matched[1].trim() : '';
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

// 产品下的列表：可以按产品注入分页缺陷（pageID 从 2 开始才出问题，第 1 页正常返回）
function productListBody(state, key, items, query, productId) {
  const pageID = Math.max(1, Number(query.pageID) || 1);
  const recPerPage = Math.min(MOCK_PAGE_SIZE, Math.max(1, Number(query.recPerPage) || MOCK_PAGE_SIZE));
  if (pageID > 1 && state.pagingStuckProducts.map(Number).includes(Number(productId))) {
    return { [key]: [], pager: { pageID: 1, recPerPage, recTotal: 0 } };
  }
  if (pageID > 1 && state.pagingRepeatProducts.map(Number).includes(Number(productId))) {
    return { [key]: items.slice(0, recPerPage), pager: { pageID, recPerPage, recTotal: items.length } };
  }
  return listBody(key, items, query);
}

// 服务端把产品列表认错了：请求产品 A，回的是产品 B 的记录（记录自己的 product 字段仍是 B）
function foreignItemsOf(state, kind, productId) {
  const actual = Number(state.foreignProductLists?.[productId] ?? 0);
  if (!actual || actual === Number(productId)) return null;
  const source = kind === 'bugs' ? state.bugs : state.feedbacks;
  return [...source.values()].filter((record) => Number(record.product) === actual);
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
    ...(state.omitActions
      ? {}
      : { actions: [{ id: id * 10, action: 'opened', actor: account, date: now(), comment: '' }] }),
  };
}

// 产品的默认承接人（QD）：建单不指定负责人时，禅道按产品的 QD 指派
function qdOf(state, productId) {
  const product = state.products.find((p) => Number(p.id) === Number(productId));
  return String(product?.QD || '');
}

// 当前账号看不见这个产品：读列表过滤、写入报业务失败（权限边界，不静默换个产品）
function visibleProductsOf(state, account) {
  const visible = state.visibleProducts?.[account];
  return Array.isArray(visible) ? visible.map(Number) : null;
}

function canSeeProduct(state, account, productId) {
  const visible = visibleProductsOf(state, account);
  return !visible || visible.includes(Number(productId));
}

// 创建接口的挂起：__TIMEOUT__ / createHang 都表示「已落库但不返回响应」
function createdResult(state, record) {
  if (state.createHang === 'ghost') return { record, persist: false, hang: true };
  if (state.createHang === 'persist') return { record, persist: true, hang: true };
  return { record, persist: true };
}

// 缺陷单：产品字段叫 productID，正文载体是 steps（富文本），openedBuild 是必填的字符串数组
function createBug(state, account, payload) {
  const marker = scenarioOf(payload.title);
  if (marker === '__FAIL__') return { fail: '『标题』不能为空。' };
  const productId = Number(payload.productID) || 0;
  if (!canSeeProduct(state, account, productId)) return { fail: '所属产品不存在，或当前账号没有权限。' };
  const record = {
    ...newRecord(state, account, payload, 'bug'),
    product: productId,
    steps: String(payload.steps || ''),
    severity: String(payload.severity || '3'),
    pri: String(payload.pri || '3'),
    type: String(payload.type || 'codeerror'),
    openedBuild: Array.isArray(payload.openedBuild) ? payload.openedBuild : [],
    project: Number(payload.project) || 0,
    execution: Number(payload.execution) || 0,
    // 载荷显式带了 assignedTo（含空串 = 不指派）就照它；没带就按产品 QD 指派
    assignedTo: payload.assignedTo === undefined ? qdOf(state, productId) : String(payload.assignedTo),
  };
  if (marker === '__ALTERED_DESC__') record.steps = '<p>服务端改写过的正文</p>';
  if (marker === '__NOOP__' || state.noopWrites) return { record, persist: false };
  if (marker === '__TIMEOUT__') return { record, persist: true, hang: true };
  return createdResult(state, record);
}

function createFeedback(state, account, payload) {
  const marker = scenarioOf(payload.title);
  if (marker === '__FAIL__') return { fail: '『反馈名称』不能为空。' };
  const productId = Number(payload.product) || 0;
  if (!canSeeProduct(state, account, productId)) return { fail: '所属产品不存在，或当前账号没有权限。' };
  const record = {
    ...newRecord(state, account, payload, 'feedback'),
    product: productId,
    desc: String(payload.desc || ''),
    type: String(payload.type || ''),
    feedbackBy: String(payload.feedbackBy || ''),
  };
  if (marker === '__ALTERED_DESC__') record.desc = '服务端改写过的正文';
  if (marker === '__NOOP__' || state.noopWrites) return { record, persist: false };
  if (marker === '__TIMEOUT__') return { record, persist: true, hang: true };
  return createdResult(state, record);
}

// 更新：__NOOP_UPDATE__ 与全局 noopUpdate 都表示「响应成功但没生效」。
// 字段按 CLI autoFill 后的完整请求体原样落到记录上：这就是真实 PUT 的语义（未提交字段由 CLI 用现值补齐）。
const UPDATABLE_FIELDS = [
  'title', 'steps', 'desc', 'type', 'assignedTo', 'severity', 'pri', 'openedBuild',
  'project', 'execution', 'story', 'product', 'module',
];

function updateRecord(state, record, payload, kind) {
  const marker = scenarioOf(record.title) || scenarioOf(payload.title);
  const noop = marker === '__NOOP_UPDATE__' || state.noopUpdate;
  const patched = { ...record };
  if (!noop) {
    for (const key of UPDATABLE_FIELDS) {
      if (payload[key] === undefined) continue;
      if (key === 'product' || key === 'project' || key === 'execution' || key === 'story' || key === 'module') {
        patched[key] = Number(payload[key]);
      } else if (key === 'severity' || key === 'pri') {
        patched[key] = String(payload[key]);
      } else {
        patched[key] = payload[key];
      }
    }
    // 正文里的图片引用：服务端可能吞掉 <img>，也可能给它补 onload（复刻真实实例行为，供回读核对用）
    if (payload.steps !== undefined) {
      if (state.bugStepsDropImage) patched.steps = patched.steps.replace(/<img\b[^>]*>/gi, '');
      if (state.bugStepsOnload) patched.steps = patched.steps.replace(/<img\b/gi, '<img onload="setImageSize(this,0)"');
    }
    if (payload.desc !== undefined && state.feedbackImageOnload) {
      patched.desc = patched.desc.replace(/<img\b/gi, '<img onload="setImageSize(this,0)"');
    }
    // 只改派负责人时，禅道记的是一条「指派」流水（不是「编辑」）；字段比较按值（数组/对象按 JSON）
    const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const onlyAssigneeChanged =
      Object.keys(payload).length > 0 &&
      Object.keys(payload).every((key) => key === 'assignedTo' || sameValue(record[key], patched[key]));
    const actionName = onlyAssigneeChanged && patched.assignedTo !== record.assignedTo ? 'assigned' : 'edited';
    if (!state.omitActions) {
      patched.actions = [...record.actions, { id: record.id * 10 + record.actions.length, action: actionName, actor: 'mock-user', date: now(), comment: '' }];
    }
  }
  return { record: patched, persist: !noop };
}

/** 追加一条流水（生命周期流转用）：omitActions 时不记，复刻真实 CLI 0.4.4 的 get 形状。 */
function appendAction(state, record, action, extra = {}) {
  if (state.omitActions) return record;
  return {
    ...record,
    ...extra,
    actions: [...(record.actions || []), { id: record.id * 10 + (record.actions || []).length, action, actor: 'mock-user', date: now(), comment: '' }],
  };
}

/** 生命周期流转里「服务端返回成功但没生效」的注入：路径命中 noopTransitions 时状态保持原样。 */
function transitionNoop(state, pathname) {
  return (state.noopTransitions || []).includes(pathname);
}

/** 缺陷状态机：resolved/closed 不能再 resolve；closed 不能直接 close；active 不能 activate。 */
function bugResolve(state, record, payload) {
  if (record.status === 'closed') return { fail: '该缺陷已关闭，不能解决。' };
  if (transitionNoop(state, 'resolve')) return { record };
  let next = {
    ...record,
    status: 'resolved',
    resolution: String(payload.resolution || ''),
    resolvedBy: 'mock-user',
    resolvedDate: payload.resolvedDate ? `${payload.resolvedDate} 10:00:00` : now(),
  };
  if (payload.resolvedBuild !== undefined) next.resolvedBuild = String(payload.resolvedBuild);
  if (payload.assignedTo !== undefined) next.assignedTo = String(payload.assignedTo);
  next = appendAction(state, next, 'resolved');
  return { record: next };
}

function bugClose(state, record) {
  if (record.status === 'closed') return { fail: '该缺陷已关闭。' };
  // 复刻多数禅道工作流：active 的缺陷必须先解决才能关闭
  if (record.status === 'active' && !state.allowCloseActiveBug) return { fail: '该缺陷未解决，不能关闭。' };
  if (transitionNoop(state, 'close')) return { record };
  const next = appendAction(state, { ...record, status: 'closed', closedBy: 'mock-user', closedDate: now() }, 'closed');
  return { record: next };
}

function bugActivate(state, record, payload) {
  if (record.status === 'active') return { fail: '该缺陷已是激活状态。' };
  if (transitionNoop(state, 'activate')) return { record };
  let next = {
    ...record,
    status: 'active',
    activatedCount: Number(record.activatedCount || 0) + 1,
    resolution: '',
    resolvedBy: '',
    resolvedDate: '',
    closedBy: '',
    closedDate: '',
  };
  if (payload.openedBuild !== undefined) next.openedBuild = Array.isArray(payload.openedBuild) ? payload.openedBuild : [String(payload.openedBuild)];
  if (payload.assignedTo !== undefined) next.assignedTo = String(payload.assignedTo);
  next = appendAction(state, next, 'activated');
  return { record: next };
}

function feedbackClose(state, record, payload) {
  if (record.status === 'closed') return { fail: '该反馈已关闭。' };
  if (transitionNoop(state, 'close')) return { record };
  const next = appendAction(
    state,
    { ...record, status: 'closed', closedReason: String(payload.closedReason || ''), closedBy: 'mock-user', closedDate: now() },
    'closed',
  );
  return { record: next };
}

function feedbackActivate(state, record, payload) {
  if (['active', 'wait', 'doing', 'review'].includes(record.status)) return { fail: '该反馈未关闭，无需激活。' };
  if (transitionNoop(state, 'activate')) return { record };
  let next = { ...record, status: payload.assignedTo ? 'doing' : 'wait', activatedBy: 'mock-user', activatedDate: now() };
  if (payload.assignedTo !== undefined) next.assignedTo = String(payload.assignedTo);
  next = appendAction(state, next, 'activated');
  return { record: next };
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

  // 官方 CLI 用账号密码登录时走的是 v2 的 users/login（与 v1 的 tokens 等价地发一个用户令牌）
  if (req.method === 'POST' && pathname === '/api.php/v2/users/login') {
    const account = String(payload.account || '');
    const password = String(payload.password || '');
    state.tokenRequests.push({ account });
    if (state.loginFails || state.accounts[account] !== password) {
      return { status: 401, body: { status: 'fail', message: '登录失败，请检查您的用户名或密码是否填写正确。' } };
    }
    return { body: { status: 'success', token: mintToken(state, account) } };
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
    const visible = visibleProductsOf(state, account);
    const products = visible ? state.products.filter((p) => visible.includes(Number(p.id))) : state.products;
    return { body: listBody('products', products, query) };
  }
  if (req.method === 'GET' && pathname === '/api.php/v2/projects') {
    return { body: listBody('projects', state.projects, query) };
  }
  if (req.method === 'GET' && pathname === '/api.php/v2/users') {
    return { body: listBody('users', state.users, query) };
  }

  let m = pathname.match(/^\/api\.php\/v2\/products\/(\d+)\/bugs$/);
  if (req.method === 'GET' && m) {
    const product = Number(m[1]);
    const own = [...state.bugs.values()].filter((b) => Number(b.product) === product);
    const items = foreignItemsOf(state, 'bugs', product) ?? own;
    return { body: productListBody(state, 'bugs', items, query, product) };
  }

  m = pathname.match(/^\/api\.php\/v2\/bugs\/(\d+)$/);
  if (m) {
    const record = state.bugs.get(Number(m[1]));
    if (req.method === 'GET') return record ? { body: { bug: record } } : { status: 404, body: { message: '记录不存在' } };
    if (req.method === 'DELETE') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      if (state.deleteFails) return { body: { status: 'fail', message: '没有删除该缺陷的权限。' } };
      state.bugs.delete(record.id);
      return { body: { status: 'success' } };
    }
    if (req.method === 'PUT') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      if (!canSeeProduct(state, account, record.product)) return { body: { status: 'fail', message: '所属产品不存在，或当前账号没有权限。' } };
      const result = updateRecord(state, record, payload, 'bug');
      if (result.persist) state.bugs.set(record.id, result.record);
      return { body: { bug: result.record } };
    }
  }

  // 缺陷生命周期：解决 / 关闭 / 激活（PUT /bugs/{id}/{action}，成功回 {status: success, ...}）
  m = pathname.match(/^\/api\.php\/v2\/bugs\/(\d+)\/(resolve|close|activate)$/);
  if (m && req.method === 'PUT') {
    const record = state.bugs.get(Number(m[1]));
    if (!record) return { status: 404, body: { message: '记录不存在' } };
    if (!canSeeProduct(state, account, record.product)) return { body: { status: 'fail', message: '所属产品不存在，或当前账号没有权限。' } };
    const handler = { resolve: bugResolve, close: bugClose, activate: bugActivate }[m[2]];
    const result = handler(state, record, payload);
    if (result.fail) return { body: { status: 'fail', message: result.fail } };
    if (!transitionNoop(state, m[2])) state.bugs.set(record.id, result.record);
    return { body: { status: 'success', bug: state.bugs.get(record.id), message: '' } };
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
    const own = [...state.feedbacks.values()].filter((f) => Number(f.product) === product);
    const seenKey = `${token}:${product}`;
    const firstGlobal = state.feedbackFirstListGlobal && !state.feedbackListSeen.has(seenKey);
    state.feedbackListSeen.add(seenKey);
    const items = firstGlobal ? [...state.feedbacks.values()] : (foreignItemsOf(state, 'feedbacks', product) ?? own);
    return { body: productListBody(state, 'feedbacks', items, query, product) };
  }

  m = pathname.match(/^\/api\.php\/v2\/feedbacks\/(\d+)$/);
  if (m) {
    const record = state.feedbacks.get(Number(m[1]));
    if (req.method === 'GET') return record ? { body: { feedback: record } } : { status: 404, body: { message: '记录不存在' } };
    if (req.method === 'DELETE') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      if (state.deleteFails) return { body: { status: 'fail', message: '没有删除该反馈的权限。' } };
      state.feedbacks.delete(record.id);
      return { body: { status: 'success' } };
    }
    if (req.method === 'PUT') {
      if (!record) return { status: 404, body: { message: '记录不存在' } };
      if (!canSeeProduct(state, account, record.product)) return { body: { status: 'fail', message: '所属产品不存在，或当前账号没有权限。' } };
      const result = updateRecord(state, record, payload, 'feedback');
      if (result.persist) state.feedbacks.set(record.id, result.record);
      return { body: { feedback: result.record } };
    }
  }

  // 反馈生命周期：关闭 / 激活
  m = pathname.match(/^\/api\.php\/v2\/feedbacks\/(\d+)\/(close|activate)$/);
  if (m && req.method === 'PUT') {
    const record = state.feedbacks.get(Number(m[1]));
    if (!record) return { status: 404, body: { message: '记录不存在' } };
    if (!canSeeProduct(state, account, record.product)) return { body: { status: 'fail', message: '所属产品不存在，或当前账号没有权限。' } };
    const handler = { close: feedbackClose, activate: feedbackActivate }[m[2]];
    const result = handler(state, record, payload);
    if (result.fail) return { body: { status: 'fail', message: result.fail } };
    if (!transitionNoop(state, m[2])) state.feedbacks.set(record.id, result.record);
    return { body: { status: 'success', feedback: state.feedbacks.get(record.id), message: '' } };
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
    // 官方 CLI 用 multipart/form-data 提交附件，挂载对象在表单字段里
    state.files.set(id, {
      id,
      size,
      objectType: multipartField(payload.__raw, 'objectType'),
      objectId: multipartField(payload.__raw, 'objectID'),
      addedBy: 'mock-user',
      addedDate: now(),
    });
    return { body: { file: state.files.get(id) } };
  }

  m = pathname.match(/^\/api\.php\/v2\/files\/(\d+)$/);
  if (req.method === 'DELETE' && m) {
    const id = Number(m[1]);
    if (!state.files.has(id)) return { status: 404, body: { message: '文件不存在' } };
    // 删掉的附件留个底：测试要回查它挂在哪个单据上
    state.deletedFiles.set(id, state.files.get(id));
    state.files.delete(id);
    return { body: { status: 'success' } };
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
    state.calls.push({ method: req.method, path: pathname, query, token, headers: req.headers, body: raw });

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
