// rh-product-feedback 技能流程的可执行参考实现。
//
// 这份代码把 SKILL.md 里的硬约束固化成行为，供 tests/e2e-mock.mjs 在 mock MCP 上验证：
//   - 写入前必须有用户确认（confirm 回调返回 false → 一次写入都不发生）
//   - 创建/更新的参数必须包在 payload 内
//   - 写入后必须按 ID 回读校验
//   - 结果不确定时先查询核实，不重复创建
//   - 业务失败（status: fail）不当作成功
//   - 补充说明保留原文，走改 desc 的路径
//
// 技能本身由 Agent 按 SKILL.md 执行；本模块不是技能的一部分，只用于测试与文档化流程。
export const FEEDBACK_TYPES = ['bug', 'story', 'advice'];

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SEPARATOR = '──────────────';

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

/** 禅道会把描述里的 \n 存成 \r\n，回读比较前先归一化换行符。 */
function sameText(a, b) {
  const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b);
}

/** 标题关键词：中文按 2-gram 切分，英文按单词切分。 */
function titleTokens(title) {
  const cleaned = String(title || '').toLowerCase().replace(/[【】\[\]（）()：:，,。.、/\\|_\-]/g, ' ');
  const tokens = new Set();
  for (const run of cleaned.match(/[一-龥]+/g) || []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const word of cleaned.match(/[a-z]{3,}/g) || []) tokens.add(word);
  return tokens;
}

function similarity(a, b) {
  const tokens = titleTokens(a);
  if (!tokens.size) return 0;
  const target = titleTokens(b);
  let hit = 0;
  for (const token of tokens) if (target.has(token)) hit++;
  return hit / tokens.size;
}

export class FeedbackAssistant {
  /**
   * @param {object} opts
   * @param {import('./mcp-client.mjs').McpClient} opts.client
   * @param {(payload: any) => Promise<boolean>} opts.confirm 用户确认回调
   * @param {{account: string, password: string}} opts.credentials
   * @param {() => string} [opts.stamp] 追加说明的时间戳
   */
  constructor({ client, confirm, credentials = { account: 'mock', password: 'mock' }, stamp = () => '2026-03-12' }) {
    this.client = client;
    this.confirm = confirm;
    this.credentials = credentials;
    this.stamp = stamp;
    this.loggedIn = false;
    this.writes = 0;
  }

  // ---- 会话与认证 -------------------------------------------------

  /**
   * 环境自检：宿主里必须已经注册禅道 MCP。
   * 未注册时给出的是「照 setup.md 引导安装」的指引，不是让用户自己去填地址。
   */
  async ensureEnvironment() {
    let tools = [];
    try {
      tools = await this.client.toolsList();
    } catch {
      throw new SkillError('mcp_unreachable', '连不上禅道 MCP：检查网络与内网地址（地址在技能包的 config.local.json 里），不要向用户索要地址。');
    }
    const hasZentao = tools.some((t) => /post_users_login|post_feedbacks/.test(t.name || ''));
    if (!hasZentao) {
      throw new SkillError('mcp_not_configured', '禅道 MCP 未注册：按 references/setup.md 引导安装——读 config.local.json 的地址 → 按宿主登记 MCP → 请用户自己写入凭据；不要向用户索要地址、账号或密码。');
    }
    return tools;
  }

  async login() {
    if (!this.credentials || !this.credentials.account) {
      this.loggedIn = false;
      throw new SkillError('not_authenticated', '本机没有禅道接入凭据：请用户自己运行 references/setup.md 里的凭据写入命令，不要在对话里索要密码或令牌。');
    }
    const res = await this.client.callTool('post_users_login', { payload: { ...this.credentials } });
    if (res.status === 'fail' || res.httpStatus === 401) {
      this.loggedIn = false;
      throw new SkillError('auth_failed', '禅道登录失败');
    }
    this.loggedIn = true;
    return res;
  }

  /** 401 → 重新登录一次并重试一次；仍失败则停止。 */
  async withAuth(run) {
    if (!this.loggedIn) await this.login();
    let res = await run();
    if (res.unauthorized || res.httpStatus === 401) {
      await this.login();
      res = await run();
      if (res.unauthorized || res.httpStatus === 401) {
        throw new SkillError('auth_failed', '重新登录后仍然 401，停止操作');
      }
    }
    return res;
  }

  // ---- 只读 ---------------------------------------------------------

  /** 当前账号可见的产品：后续选产品的候选范围。 */
  async listProducts() {
    const res = await this.withAuth(() => this.client.callTool('get_products', { pageID: '1', recPerPage: '100' }));
    if (res.status === 'fail' || !res.data) return [];
    return res.data.products || [];
  }

  async listFeedbacks(productId, { recPerPage = 100, maxPages = 3 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.withAuth(() => this.client.callTool('get_products_productID_feedbacks', {
        productID: String(productId), pageID: String(page), recPerPage: String(recPerPage),
      }));
      if (res.status === 'fail' || !res.data) break;
      const list = res.data.feedbacks || [];
      out.push(...list);
      const pager = res.data.pager || {};
      if (list.length === 0 || (pager.pageTotal && page >= pager.pageTotal)) break;
    }
    return out;
  }

  /** 客户端查重：分页拉取 + 标题关键词匹配。 */
  async findDuplicates(productId, title, { threshold = 0.5 } = {}) {
    const list = await this.listFeedbacks(productId);
    return list
      .map((f) => ({ ...f, score: similarity(title, f.title) }))
      .filter((f) => f.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  async readBack(id) {
    const res = await this.withAuth(() => this.client.callTool('get_feedbacks_feedbackID', { feedbackID: String(id) }));
    if (res.status === 'fail' || !res.data?.feedback) {
      return { found: false, raw: res.data, httpStatus: res.httpStatus, actions: [] };
    }
    const fb = res.data.feedback;
    return {
      found: true,
      feedback: fb,
      status: fb.status,
      assignedTo: fb.assignedTo || '',
      actions: (res.data.actions || fb.actions || []).map((a) => a.action),
      raw: res.data,
    };
  }

  // ---- 写入 ---------------------------------------------------------

  async submit({ title, desc, type, productId }) {
    if (!FEEDBACK_TYPES.includes(type)) throw new SkillError('bad_type', `未知反馈类型：${type}`);

    const duplicates = await this.findDuplicates(productId, title);
    const approved = await this.confirm({ kind: 'submit', draft: { title, desc, type, productId }, duplicates });
    if (!approved) return { status: 'cancelled', writes: 0, duplicates };

    let created;
    try {
      created = await this.withAuth(() => this.client.callTool('post_feedbacks', {
        payload: { product: productId, title, desc, type },
      }));
    } catch (err) {
      if (err?.code === 'auth_failed') throw err;
      created = { timedOut: true, httpStatus: 0, status: null, data: null };
    }

    // 结果不确定：先查后报，绝不重复创建
    if (created.timedOut || created.httpStatus === 0 || created.status === null) {
      const found = await this.findDuplicates(productId, title, { threshold: 0.99 });
      if (found.length) {
        const detail = await this.readBack(found[0].id);
        return { status: 'created', recovered: true, id: found[0].id, writes: 1, detail, duplicates };
      }
      return { status: 'unknown', needsUserDecision: true, writes: 1, duplicates };
    }

    if (created.status === 'fail') {
      return { status: 'failed', message: describeFailure(created.data), writes: 1, duplicates };
    }

    const id = created.data?.id;
    const detail = await this.readBack(id);
    const consistent = detail.found && detail.feedback.title === title && sameText(detail.feedback.desc, desc);
    if (!consistent) {
      return { status: 'inconsistent', id, writes: 1, detail, duplicates };
    }
    return { status: 'created', id, writes: 1, detail, duplicates };
  }

  async supplement({ id, addition }) {
    const before = await this.readBack(id);
    if (!before.found) return { status: 'not_found', writes: 0 };

    const original = (before.feedback.desc || '').replace(/\r\n/g, '\n');
    const nextDesc = `${original}\n\n${SEPARATOR}\n【补充说明 · ${this.stamp()} · 用户口述，AI 整理】\n${addition}`;

    const approved = await this.confirm({ kind: 'supplement', id, original, next: nextDesc });
    if (!approved) return { status: 'cancelled', writes: 0 };

    const updated = await this.withAuth(() => this.client.callTool('put_feedbacks_feedbackID', {
      feedbackID: String(id),
      // product 必须是数字：传字符串会被服务端静默忽略，回读才发现没生效。
      payload: { product: Number(before.feedback.product), title: before.feedback.title, desc: nextDesc },
    }));
    if (updated.status === 'fail') {
      return { status: 'failed', message: describeFailure(updated.data), writes: 1 };
    }

    const after = await this.readBack(id);
    const storedDesc = (after.feedback?.desc || '').replace(/\r\n/g, '\n');
    const kept = after.found && storedDesc.includes(original.trim());
    const appended = after.found && storedDesc.includes(addition);
    const edited = after.actions.includes('edited');
    if (!(kept && appended && edited)) {
      return { status: 'inconsistent', id, writes: 1, detail: after };
    }
    return { status: 'updated', id, writes: 1, detail: after };
  }

  // ---- 解释 ---------------------------------------------------------

  /** 事实 / 推断 / 无法确定 三段式。 */
  async explain(id) {
    const detail = await this.readBack(id);
    if (!detail.found) return { status: 'not_found', facts: [], inferences: [], unknown: [] };
    const fb = detail.feedback;
    const actions = detail.raw?.actions || fb.actions || [];

    const facts = [`当前状态：${fb.status || '未知'}`, `负责人：${fb.assignedTo || '未指派'}`];
    for (const a of actions) {
      facts.push(`${a.date || ''} ${a.actor || ''} ${a.action || ''}${a.comment ? `：${a.comment}` : ''}`);
    }

    const inferences = [];
    if (fb.reviewedDate && !fb.result && !fb.solution) {
      inferences.push('评审动作已发生，但结论字段仍为空，推断评审尚未给出结论（依据：reviewedDate 有值而 result/solution 为空）');
    }
    if (!fb.version && !fb.plan) {
      inferences.push('禅道里没有版本/计划记录，推断尚未进入排期（依据：version 与 plan 均为空）');
    }

    const unknown = [];
    if (!fb.version && !fb.plan) {
      unknown.push('未排期的原因：接口没有该字段，也没有可引用的评论说明');
    }
    if (!fb.result && !fb.solution) {
      unknown.push('最终处理结论：result / solution 均为空');
    }

    return { status: 'ok', facts, inferences, unknown, detail };
  }
}

function describeFailure(data) {
  if (!data) return '未知错误';
  const msg = data.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object') {
    return Object.entries(msg).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join(' | ');
  }
  return String(msg);
}
