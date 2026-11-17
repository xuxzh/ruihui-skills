// 本地 mock 的禅道 MCP：复刻真实服务端的关键行为，用于在没有禅道环境时验证技能流程。
//
// 复刻的行为（均来自 Issue #1 的实测）：
//   1. 创建/更新类工具的参数必须包在 payload 内；扁平参数被静默忽略 → 报业务错「『反馈名称』不能为空。」
//   2. 业务失败返回 HTTP 200 + {"status":"fail","message":...}
//   3. 未登录调用数据接口返回 HTTP 401
//   4. 创建接口无幂等：同一 payload 调两次产生两个 id
//   5. 「保存成功」不等于落库：__NOOP__ 场景返回成功但记录不存在
//   6. 创建可能超时：__TIMEOUT__ 场景不返回响应
//
// 场景通过标题标记注入：
//   __FAIL__          → 业务失败
//   __NOOP__          → 返回成功但不落库
//   __TIMEOUT__       → 已落库但不返回响应
//   __TIMEOUT_GHOST__ → 不落库也不返回响应
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
];

function feedbackView(fb) {
  return { ...fb, actions: fb.actions.map((a) => ({ ...a })) };
}

function handleToolCall(state, session, name, args) {
  state.calls.push({ name, args });

  if (name === 'post_users_login') {
    if (state.loginFails) return { payload: { message: '账号或密码错误', status: 'fail' } };
    session.loggedIn = true;
    return { payload: { status: 'success', token: '{{SECRET_mock}}', user: { account: 'shared-service-account', admin: false } } };
  }

  if (!session.loggedIn) return { httpStatus: 401, payload: { message: 'Unauthorized', status: 'fail' } };

  if (name === 'get_products') {
    return { payload: { pager: { recTotal: MOCK_PRODUCTS.length, pageTotal: 1, pageID: 1, recPerPage: 20 }, products: MOCK_PRODUCTS } };
  }

  if (name === 'get_products_productID_feedbacks') {
    const productID = Number(args.productID);
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
    if (payload.title.includes('__FAIL__')) {
      return { payload: { message: 'Product does not exist.', status: 'fail' } };
    }
    const id = state.nextId++;
    if (payload.title.includes('__NOOP__')) {
      // 行为 5：返回成功但不落库
      return { payload: { id, message: '保存成功', status: 'success' } };
    }
    if (payload.title.includes('__TIMEOUT__')) {
      // 行为 6：已落库但不返回响应
      state.feedbacks.set(String(id), {
        id, product: payload.product, title: payload.title, desc: payload.desc || '', type: payload.type || '',
        status: 'wait', assignedTo: '', feedbackBy: 'shared-service-account', actions: [{ action: 'opened', actor: 'shared-service-account', comment: '', date: '2026-03-11 10:22' }],
      });
      return { hang: true };
    }
    if (payload.title.includes('__TIMEOUT_GHOST__')) {
      return { hang: true };
    }
    state.feedbacks.set(String(id), {
      id, product: payload.product, title: payload.title, desc: payload.desc || '', type: payload.type || '',
      status: 'wait', assignedTo: '', feedbackBy: 'shared-service-account', actions: [{ action: 'opened', actor: 'shared-service-account', comment: '', date: '2026-03-11 10:22' }],
    });
    return { payload: { id, message: '保存成功', status: 'success' } };
  }

  if (name === 'put_feedbacks_feedbackID') {
    const payload = args.payload;
    const fb = state.feedbacks.get(String(args.feedbackID));
    if (!fb) return { payload: { message: `对象不存在：${args.feedbackID}`, status: 'fail' } };
    if (!payload || !payload.title || !payload.product) {
      return { payload: { message: { title: ['『反馈名称』不能为空。'] }, status: 'fail' } };
    }
    fb.title = payload.title;
    fb.desc = payload.desc ?? fb.desc;
    fb.actions.push({ action: 'edited', actor: 'shared-service-account', comment: '', date: '2026-03-12 09:05' });
    return { payload: { id: fb.id, message: '保存成功', status: 'success' } };
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
      return ok(res, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } });
    }

    if (body.method === 'tools/call') {
      const result = handleToolCall(state, session, body.params?.name, body.params?.arguments || {});
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
