// 本地 mock 的禅道 MCP：复刻真实服务端的关键行为，用于在没有禅道环境时验证技能流程。
//
// 复刻的行为（均来自 Issue #1 的实测）：
//   1. 创建/更新类工具的参数必须包在 payload 内；扁平参数被静默忽略 → 报业务错「『反馈名称』不能为空。」
//   2. 业务失败返回 HTTP 200 + {"status":"fail","message":...}
//   3. 未登录调用数据接口返回 HTTP 401
//   4. 创建接口无幂等：同一 payload 调两次产生两个 id
//   5. 「保存成功」不等于落库：__NOOP__ 场景返回成功但记录不存在
//   6. 创建可能超时：__TIMEOUT__ 场景不返回响应
//   7. 落库但没有 opened 流水：__NO_OPENED__
//   8. 落库但描述被服务端改写：__ALTERED_DESC__
//   9. 更新返回成功但没生效：__NOOP_UPDATE__（不改描述，也不新增 edited 流水）
//  10. payload 在、但缺必填字段：返回 JSON-RPC 参数错误（HTTP 200，正文是 error），
//      没有业务响应——请求根本没被执行
//
// 场景通过标题标记注入：
//   __FAIL__          → 业务失败
//   __NOOP__          → 返回成功但不落库
//   __TIMEOUT__       → 已落库但不返回响应
//   __TIMEOUT_GHOST__ → 不落库也不返回响应
//   __NO_OPENED__     → 已落库但没有 opened 流水
//   __ALTERED_DESC__  → 已落库但描述被改写
//   __NOOP_UPDATE__   → 更新返回成功但不生效
// 另外可用 state.createHang 注入创建行为（'ghost'/'persist'），
// 用 state.deleteFails 注入删除失败。
import http from 'node:http';

export const MOCK_PRODUCTS = [
  { id: 101, name: '示例产品 A' },
  { id: 102, name: '示例产品 B' },
];

export function createMockState(overrides = {}) {
  return {
    feedbacks: new Map(),
    nextId: 900,
    calls: [],
    sessions: new Map(),
    loginFails: false,
    // 登录账号 → 可见产品 ID 列表；不设则全部可见
    visibleProducts: null,
    // tools/list 返回空数组，模拟「宿主里没注册禅道 MCP」
    hideTools: false,
    // 删除类调用是否失败（测试注入）
    deleteFails: false,
    // 创建接口行为注入：null=正常，'ghost'=不落库也不响应，'persist'=落库但不响应
    createHang: null,
    ...overrides,
  };
}

function ok(res, result, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

function toolText(res, body, status = 200) {
  ok(res, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `HTTP ${status}\n${JSON.stringify(body.payload)}` }] } }, status);
}

function businessFail(res, body, message) {
  toolText(res, { payload: { message, status: 'fail' } }, 200);
}

const TOOLS = [
  { name: 'post_users_login', description: '获取 Token', inputSchema: { type: 'object', properties: { payload: { type: 'object', properties: { account: { type: 'string' }, password: { type: 'string' } } } } } },
  { name: 'get_products', description: '产品列表', inputSchema: { type: 'object', properties: { pageID: { type: 'string' }, recPerPage: { type: 'string' } } } },
  { name: 'get_products_productID_feedbacks', description: '产品反馈列表', inputSchema: { type: 'object', properties: { productID: { type: 'string' }, pageID: { type: 'string' }, recPerPage: { type: 'string' } } } },
  { name: 'get_feedbacks_feedbackID', description: '反馈详情', inputSchema: { type: 'object', properties: { feedbackID: { type: 'string' } } } },
  { name: 'post_feedbacks', description: '创建反馈', inputSchema: { type: 'object', properties: { payload: { type: 'object', properties: { product: { type: 'integer' }, title: { type: 'string' }, desc: { type: 'string' }, type: { type: 'string' } } } } } },
  { name: 'put_feedbacks_feedbackID', description: '更新反馈', inputSchema: { type: 'object', properties: { feedbackID: { type: 'string' }, payload: { type: 'object', properties: { product: { type: 'integer' }, title: { type: 'string' }, desc: { type: 'string' } } } } } },
  { name: 'delete_feedbacks_feedbackID', description: '删除反馈', inputSchema: { type: 'object', properties: { feedbackID: { type: 'string' } } } },
];

/** 工具的 payload 必填字段：真实 MCP 在缺字段时返回 JSON-RPC -32602。 */
const REQUIRED_PAYLOAD_FIELDS = {
  post_feedbacks: ['product', 'title'],
  put_feedbacks_feedbackID: ['product', 'title'],
};
/** 真实 MCP 的参数错误形状：HTTP 200，正文是 JSON-RPC error，没有业务响应。 */
function invalidParams(id, missing) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message: `invalid params: validating "arguments": validating root: validating /properties/payload: required: missing properties: [${missing.map((k) => `"${k}"`).join(' ')}]`,
    },
  };
}
function feedbackView(fb) {
  return { ...fb, actions: fb.actions.map((a) => ({ ...a })) };
}

/** 当前登录账号可见的产品；state.visibleProducts 为空时全部可见。 */
function visibleProducts(state, session) {
  if (!state.visibleProducts) return MOCK_PRODUCTS;
  const ids = state.visibleProducts[session.account] ?? [];
  return MOCK_PRODUCTS.filter((p) => ids.includes(p.id));
}

/** 产品对当前账号不可见时，禅道侧表现为「不存在」。 */
function productVisible(state, session, productId) {
  return visibleProducts(state, session).some((p) => p.id === Number(productId));
}

function handleToolCall(state, session, name, args) {
  if (name === 'post_users_login') {
    if (state.loginFails) return { payload: { message: '账号或密码错误', status: 'fail' } };
    session.loggedIn = true;
    session.account = args?.payload?.account || 'unknown';
    return { payload: { status: 'success', token: '{{SECRET_mock}}', user: { account: session.account, admin: false } } };
  }

  if (!session.loggedIn) return { httpStatus: 401, payload: { message: 'Unauthorized', status: 'fail' } };

  if (name === 'get_products') {
    const products = visibleProducts(state, session);
    return { payload: { pager: { recTotal: products.length, pageTotal: 1, pageID: 1, recPerPage: 20 }, products } };
  }

  if (name === 'get_products_productID_feedbacks') {
    const productID = Number(args.productID);
    if (!productVisible(state, session, productID)) {
      return { payload: { message: 'Product does not exist.', status: 'fail' } };
    }
    const list = [...state.feedbacks.values()].filter((f) => f.product === productID);
    return { payload: { pager: { recTotal: list.length, pageTotal: 1, pageID: 1, recPerPage: list.length || 20 }, feedbacks: list.map(feedbackView) } };
  }

  if (name === 'get_feedbacks_feedbackID') {
    const fb = state.feedbacks.get(String(args.feedbackID));
    if (!fb) return { payload: { message: `对象不存在：${args.feedbackID}`, status: 'fail' } };
    return { payload: { feedback: feedbackView(fb), status: fb.status } };
  }

  if (name === 'post_feedbacks') {
    const payload = args.payload;
    // 行为 1：扁平参数被忽略 → 业务必填校验失败
    if (!payload || typeof payload !== 'object') {
      return { payload: { message: { title: ['『反馈名称』不能为空。'] }, status: 'fail' } };
    }
    if (!payload.title) {
      return { payload: { message: { title: ['『反馈名称』不能为空。'] }, status: 'fail' } };
    }
    if (!payload.product) {
      return { payload: { message: { product: ['『所属产品』不能为空。'] }, status: 'fail' } };
    }
    if (!productVisible(state, session, payload.product)) {
      return { payload: { message: 'Product does not exist.', status: 'fail' } };
    }
    if (payload.title.includes('__FAIL__')) {
      return { payload: { message: 'Product does not exist.', status: 'fail' } };
    }
    const id = state.nextId++;
    if (payload.title.includes('__NOOP__')) {
      // 行为 5：返回成功但不落库
      return { payload: { id, message: '保存成功', status: 'success' } };
    }
    const persist = () => {
      const actions = payload.title.includes('__NO_OPENED__')
        ? [] // 行为 7：落库但没有 opened 流水
        : [{ action: 'opened', actor: session.account, comment: '', date: '2026-03-11 10:22' }];
      const desc = payload.title.includes('__ALTERED_DESC__')
        ? `${payload.desc || ''}\n（禅道侧自动改写）` // 行为 8：落库但描述被改写
        : payload.desc || '';
      state.feedbacks.set(String(id), {
        id, product: payload.product, title: payload.title, desc, type: payload.type || '',
        status: 'wait', assignedTo: '', feedbackBy: session.account, actions,
      });
    };
    // 测试注入的创建行为：'ghost'=不落库也不响应，'persist'=落库但不响应
    if (state.createHang === 'ghost') return { hang: true };
    if (state.createHang === 'persist') {
      persist();
      return { hang: true };
    }
    if (payload.title.includes('__TIMEOUT__')) {
      // 行为 6：已落库但不返回响应
      persist();
      return { hang: true };
    }
    if (payload.title.includes('__TIMEOUT_GHOST__')) {
      return { hang: true };
    }
    persist();
    return { payload: { id, message: '保存成功', status: 'success' } };
  }

  if (name === 'put_feedbacks_feedbackID') {
    const payload = args.payload;
    const fb = state.feedbacks.get(String(args.feedbackID));
    if (!fb) return { payload: { message: `对象不存在：${args.feedbackID}`, status: 'fail' } };
    if (!payload || !payload.title || !payload.product) {
      return { payload: { message: { title: ['『反馈名称』不能为空。'] }, status: 'fail' } };
    }
    if (fb.title.includes('__NOOP_UPDATE__')) {
      // 行为 9：返回成功但更新没生效——不改描述，也不新增 edited 流水
      return { payload: { id: fb.id, message: '保存成功', status: 'success' } };
    }
    fb.title = payload.title;
    fb.desc = payload.desc ?? fb.desc;
    fb.actions.push({ action: 'edited', actor: session.account, comment: '', date: '2026-03-12 09:05' });
    return { payload: { id: fb.id, message: '保存成功', status: 'success' } };
  }
  if (name === 'delete_feedbacks_feedbackID') {
    const key = String(args.feedbackID);
    if (state.deleteFails) {
      return { payload: { message: '删除失败（测试注入）', status: 'fail' } };
    }
    const fb = state.feedbacks.get(key);
    if (!fb) return { payload: { message: `对象不存在：${args.feedbackID}`, status: 'fail' } };
    state.feedbacks.delete(key);
    return { payload: { id: fb.id, message: '删除成功', status: 'success' } };
  }

  return { payload: { message: `未知工具：${name}`, status: 'fail' } };
}

export function startMockServer(overrides = {}) {
  const state = createMockState(overrides);

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') return ok(res, { error: 'method not allowed' }, 405);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return ok(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
    }

    const sessionId = req.headers['mcp-session-id'] || 'default';

    if (body.method === 'initialize') {
      const sid = `sess-${state.sessions.size + 1}`;
      state.sessions.set(sid, { loggedIn: false });
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'zentao', version: '' } } }));
    }

    if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }

    const session = state.sessions.get(sessionId) || { loggedIn: false };
    state.sessions.set(sessionId, session);

    if (body.method === 'tools/list') {
      return ok(res, { jsonrpc: '2.0', id: body.id, result: { tools: state.hideTools ? [] : TOOLS } });
    }

    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      // 服务端收到了调用就记录——包括被参数校验拒绝的
      state.calls.push({ name, args });
      const required = REQUIRED_PAYLOAD_FIELDS[name];
      if (required && args.payload && typeof args.payload === 'object') {
        const missing = required.filter((k) => args.payload[k] === undefined || args.payload[k] === null);
        if (missing.length) return ok(res, invalidParams(body.id, missing), 200);
      }
      const result = handleToolCall(state, session, name, args);
      if (result.hang) return; // 故意不响应，模拟超时
      if (result.httpStatus === 401) {
        return ok(res, { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Unauthorized' } }, 401);
      }
      return toolText(res, { id: body.id, payload: result.payload }, 200);
    }

    return ok(res, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        state,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
