// rh-product-feedback 技能流程的可执行参考实现。
//
// 这份代码把 SKILL.md 里的硬约束固化成行为，供 tests/e2e-mock.mjs 在 mock MCP 上验证：
//   - 写入前必须有用户确认（confirm 回调返回 false → 一次写入都不发生）
//   - 创建/更新的参数必须包在 payload 内
//   - 写入后必须按 ID 回读校验
//   - 结果不确定时先查询核实，不重复创建；只认写入前不存在、现在唯一存在的记录
//   - 业务失败（status: fail）不当作成功
//   - 补充说明保留原文，走改 desc 的路径；写前二次回读，原文被改就停手
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

/** 禅道会把描述里的 \n 存成 \r\n（真实 E2E 实测确认），回读比较前先归一化换行符。 */
function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}
function sameText(a, b) {
  const norm = (t) => normalizeNewlines(t).trim();
  return norm(a) === norm(b);
}
/** 标题按去除首尾空白后精确比较。 */
function sameTitle(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}
/**
 * JSON-RPC 层面的拒绝：参数不合法（-32602）或工具不存在（-32601）。
 * 这类是「请求根本没被执行」，不是「结果不确定」——不能拿它去做恢复扫描。
 */
function isRejected(res) {
  return !!res?.error && (res.error.code === -32602 || res.error.code === -32601);
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

  async scanFeedbacks(productId, { recPerPage = 100, maxPages = 3 } = {}) {
    const items = [];
    let complete = true;
    let error = null;
    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await this.withAuth(() => this.client.callTool('get_products_productID_feedbacks', {
          productID: String(productId), pageID: String(page), recPerPage: String(recPerPage),
        }));
      } catch (err) {
        // 认证类失败直接往上抛；只有网络类失败才当作「扫描不完整」。
        if (err instanceof SkillError) throw err;
        complete = false;
        error = `读取反馈列表失败：${err.message}`;
        break;
      }
      if (res.status === 'fail' || !res.data) {
        complete = false;
        error = `读取反馈列表失败：${describeFailure(res.data)}`;
        break;
      }
      const list = res.data.feedbacks || [];
      items.push(...list);
      const pager = res.data.pager || {};
      if (list.length === 0) break;
      if (pager.pageTotal && page >= pager.pageTotal) break;
      if (!pager.pageTotal && list.length >= recPerPage) {
        complete = false;
        error = '响应未给出总页数，无法确认已覆盖全部反馈';
        break;
      }
      if (page === maxPages) {
        complete = false;
        error = `扫描达到 ${maxPages} 页上限，未覆盖该产品的全部反馈`;
      }
    }
    return { items, complete, error };
  }
  async listFeedbacks(productId, { recPerPage = 100, maxPages = 3 } = {}) {
    const { items } = await this.scanFeedbacks(productId, { recPerPage, maxPages });
    return items;
  }

  /** 客户端查重：分页拉取 + 标题关键词匹配。 */
  async findDuplicates(productId, title, { threshold = 0.5 } = {}) {
    const { items } = await this.scanFeedbacks(productId);
    return items
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
  /** 回读结果是否与本次提交的草稿完全一致：产品、标题、完整描述、opened 流水。 */
  matchesDraft(detail, { productId, title, desc }) {
    if (!detail?.found) return false;
    const fb = detail.feedback || {};
    if (Number(fb.product) !== Number(productId)) return false;
    if (!sameTitle(fb.title, title)) return false;
    if (!sameText(fb.desc, desc)) return false;
    if (!detail.actions.includes('opened')) return false;
    return true;
  }
  /**
   * 创建结果不确定时的核实：只认「写入前不存在、现在唯一存在、且回读完全一致」的记录。
   * 写入前已存在的同名反馈不在候选里——只看同名会把旧记录误当成新建成功。
   */
  async recoverCreate({ productId, title, desc, baselineIds, baselineComplete, duplicates }) {
    if (!baselineComplete) {
      return {
        status: 'unknown', reason: 'baseline_incomplete', writes: 1, duplicates,
        message: '创建未拿到确认，写入前的扫描不完整，无法区分本次新建与既有反馈；未重复创建，请人工核对禅道',
      };
    }
    const after = await this.scanFeedbacks(productId);
    if (!after.complete) {
      return {
        status: 'unknown', reason: 'scan_incomplete', writes: 1, duplicates,
        message: `创建未拿到确认，复查反馈列表不完整（${after.error || '未知原因'}）；未重复创建，请人工核对禅道`,
      };
    }
    const candidates = after.items.filter(
      (f) => !baselineIds.has(String(f.id)) && sameTitle(f.title, title),
    );
    const verified = [];
    for (const candidate of candidates) {
      const detail = await this.readBack(candidate.id);
      if (this.matchesDraft(detail, { productId, title, desc })) verified.push({ id: candidate.id, detail });
    }
    if (verified.length === 1) {
      return { status: 'created', recovered: true, id: verified[0].id, writes: 1, detail: verified[0].detail, duplicates };
    }
    if (verified.length > 1) {
      return {
        status: 'ambiguous', reason: 'multiple_candidates', writes: 1, duplicates,
        candidates: verified.map((v) => v.id),
        message: `创建未拿到确认，查到 ${verified.length} 条可能本次创建的反馈（${verified.map((v) => `#${v.id}`).join('、')}），无法唯一确认；未重复创建`,
      };
    }
    return {
      status: 'unknown', reason: 'no_match', writes: 1, duplicates,
      message: '创建未拿到确认，复查未发现本次写入的新记录，不能断定禅道是否已落库；未重复创建，请人工核对后再决定',
    };
  }
  async submit({ title, desc, type, productId }) {
    if (!FEEDBACK_TYPES.includes(type)) throw new SkillError('bad_type', `未知反馈类型：${type}`);
    // 写入前先把该产品的反馈扫一遍：既是查重，也是「本次新建」的 ID 基线。
    const scan = await this.scanFeedbacks(productId);
    const duplicates = scan.items
      .map((f) => ({ ...f, score: similarity(title, f.title) }))
      .filter((f) => f.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    const baselineIds = new Set(scan.items.map((f) => String(f.id)));
    const approved = await this.confirm({ kind: 'submit', draft: { title, desc, type, productId }, duplicates });
    if (!approved) return { status: 'cancelled', writes: 0, duplicates };
    let created;
    try {
      created = await this.withAuth(() => this.client.callTool('post_feedbacks', {
        payload: { product: productId, title, desc, type },
      }));
    } catch (err) {
      if (err instanceof SkillError) throw err;
      created = { timedOut: true, httpStatus: 0, status: null, data: null };
    }
    // 请求被服务端拒绝（参数不合法、工具不存在）：根本没执行，按失败处理
    if (isRejected(created)) {
      return { status: 'failed', message: `请求被服务端拒绝：${created.error.message}`, writes: 1, duplicates };
    }
    // 结果不确定：先查后报，绝不重复创建
    if (created.timedOut || created.httpStatus === 0 || created.status === null) {
      return await this.recoverCreate({
        productId, title, desc, baselineIds, baselineComplete: scan.complete, duplicates,
      });
    }
    if (created.status === 'fail') {
      return { status: 'failed', message: describeFailure(created.data), writes: 1, duplicates };
    }
    const id = created.data?.id;
    if (!id) {
      return { status: 'inconsistent', writes: 1, duplicates, message: '创建响应没有给出反馈 ID，无法回读确认' };
    }
    const detail = await this.readBack(id);
    if (!this.matchesDraft(detail, { productId, title, desc })) {
      return { status: 'inconsistent', id, writes: 1, detail, duplicates };
    }
    return { status: 'created', id, writes: 1, detail, duplicates };
  }
  async supplement({ id, addition }) {
    const before = await this.readBack(id);
    if (!before.found) return { status: 'not_found', writes: 0 };
    const original = normalizeNewlines(before.feedback.desc || '');
    const nextDesc = `${original}\n\n${SEPARATOR}\n【补充说明 · ${this.stamp()} · 用户口述，AI 整理】\n${addition}`;
    const approved = await this.confirm({ kind: 'supplement', id, original, next: nextDesc });
    if (!approved) return { status: 'cancelled', writes: 0 };
    // 用户确认后、写入前再读一次：原文被他人改动时停止写入，不覆盖新内容。
    const recheck = await this.readBack(id);
    if (!recheck.found) return { status: 'not_found', writes: 0, message: '写入前复核时反馈已不存在' };
    const current = normalizeNewlines(recheck.feedback.desc || '');
    const changed =
      !sameText(current, original)
      || !sameTitle(recheck.feedback.title, before.feedback.title)
      || Number(recheck.feedback.product) !== Number(before.feedback.product);
    if (changed) {
      return {
        status: 'conflict', needsUserDecision: true, writes: 0,
        message: '写入前复核发现该反馈已被他人修改，本次补充未写入；请确认重新合并后的草稿',
        current: { title: recheck.feedback.title, product: recheck.feedback.product, desc: current },
      };
    }
    const editedBefore = (recheck.actions || []).filter((a) => a === 'edited').length;
    let updated;
    try {
      updated = await this.withAuth(() => this.client.callTool('put_feedbacks_feedbackID', {
        feedbackID: String(id),
        // product 必须是数字：传字符串会被服务端静默忽略，回读才发现没生效。
        payload: { product: Number(before.feedback.product), title: before.feedback.title, desc: nextDesc },
      }));
    } catch (err) {
      if (err instanceof SkillError) throw err;
      updated = { timedOut: true, httpStatus: 0, status: null, data: null };
    }
    if (isRejected(updated)) {
      return { status: 'failed', message: `请求被服务端拒绝：${updated.error.message}`, writes: 1 };
    }
    if (updated.status === 'fail') {
      return { status: 'failed', message: describeFailure(updated.data), writes: 1 };
    }
    const uncertain = updated.timedOut || updated.httpStatus === 0 || updated.status === null;
    const after = await this.readBack(id);
    const storedDesc = normalizeNewlines(after.feedback?.desc || '');
    // 完整预期描述归一化后精确比较；流水看本次是否新增 edited，而不是历史上有没有。
    const descMatched = after.found && sameText(storedDesc, nextDesc);
    const editedAfter = (after.actions || []).filter((a) => a === 'edited').length;
    const editedAdded = editedAfter > editedBefore;
    if (descMatched && editedAdded) {
      return { status: 'updated', id, writes: 1, detail: after, ...(uncertain ? { recovered: true } : {}) };
    }
    if (uncertain) {
      return {
        status: 'unknown', reason: 'update_unconfirmed', id, writes: 1, detail: after,
        message: '更新未拿到确认，已只读核实；未重放更新，请人工核对后再决定',
      };
    }
    return {
      status: 'inconsistent', id, writes: 1, detail: after,
      message: descMatched ? '描述已更新，但操作流水没有新增 edited' : '回读描述与本次预期不一致',
    };
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
