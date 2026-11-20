// rh-product-feedback 技能流程的可执行参考实现。
//
// 这份代码把 SKILL.md 里的硬约束固化成行为，供 tests/e2e-mock.mjs 在假禅道 API v2 服务上验证：
//   - 写入前必须有用户确认（confirm 回调返回 false → 一次写入都不发生）
//   - 正文经载荷文件交给入口脚本，不进命令行参数
//   - 写入后必须按 ID 回读校验（回读字段由入口脚本投影，Agent 只见投影后的结果）
//   - 结果不确定时先查询核实，不重复创建；只认写入前不存在、现在唯一存在的记录
//   - 业务失败（status: fail）不当作成功
//   - 补充说明保留原文，走改正文的路径；写前二次回读，原文被改就停手
//   - 缺陷单（bug 对象）走同一套硬约束，差异在字段名（productID）与正文载体（steps）
//     - openedBuild 必填；回读比较前要剥掉 HTML 标签并归一化空白
//     - 查重、结果不确定时的「先查后报」规则与反馈单一致
//
// 通道：一切读写都经随包入口脚本（scripts/zentao.mjs）的子命令——它换令牌、注入官方禅道 CLI、
// 落载荷、回读核对。这里不直连禅道，也不碰令牌。
// 技能本身由 Agent 按 SKILL.md 执行；本模块不是技能的一部分，只用于测试与文档化流程。
export const FEEDBACK_TYPES = ['bug', 'story', 'advice'];
export const BUG_TYPES = [
  'codeerror', 'config', 'install', 'security',
  'performance', 'standard', 'automation', 'designdefect', 'others',
];

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 追加草稿的分隔行：草稿 = 原文 + 分隔行 + 标注 + 追加段落。
// 入口脚本按同一条线拆草稿（skills/rh-product-feedback/scripts/zentao.mjs 的 APPEND_SEPARATOR）。
export const SEPARATOR = '──────────────';

/**
 * 追加草稿：原文 + 空行 + 分隔行 + 追加部分。
 * 少了分隔行，入口脚本会报「草稿里找不到分隔行」并拒绝写入——这就是追加草稿的契约。
 */
export function appendDraft(original, appended) {
  return `${original}\n\n${SEPARATOR}\n${appended}`;
}

/** 禅道会把描述里的 \n 存成 \r\n（真实 E2E 实测确认），回读比较前先归一化换行符。 */
function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
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

/** 入口脚本给出的失败原文：stdout 的 JSON 里带 error，stderr 是给人看的那一行。 */
function failureMessage(res) {
  const data = res?.data || {};
  if (data.error) return String(data.error);
  if (data.message) return String(data.message);
  return String(res?.stderr || '').trim().replace(/^错误：/, '') || '未知错误';
}

/** 禅道 CLI 没装：报错原文来自入口脚本的「找不到 zentao 命令」。 */
function cliMissing(res) {
  return /找不到 zentao 命令/.test(failureMessage(res));
}

/** 凭据/令牌类失败：这几类要引导用户自己写凭据，而不是在对话里索要密码。 */
function credentialProblem(res) {
  return /凭据|锁定|Token|令牌|认证|登录/.test(failureMessage(res));
}

/** 凭据类失败统一抛 not_authenticated，其余按脚本给的原文抛 auth_failed。 */
function throwIfCredentialProblem(res) {
  if (!credentialProblem(res)) return;
  throw new SkillError(
    'not_authenticated',
    `${failureMessage(res)} 按 references/setup.md 用 connect.mjs 起本机页面让终端用户自己填凭据，不要在对话里索要密码或令牌。`,
  );
}

export class FeedbackAssistant {
  /**
   * @param {object} opts
   * @param {import('./zentao-client.mjs').ZentaoEntry} opts.zentao 入口脚本适配器
   * @param {(payload: any) => Promise<boolean>} opts.confirm 用户确认回调
   * @param {() => string} [opts.stamp] 追加说明的时间戳
   */
  constructor({ zentao, confirm, stamp = () => '2026-03-12' }) {
    this.zentao = zentao;
    this.confirm = confirm;
    this.stamp = stamp;
  }

  // ---- 会话与接入自检 -----------------------------------------------

  /**
   * 接入自检：入口脚本能连上禅道、能看到产品。
   * 未通过时给的是「照 setup.md 引导安装/写凭据」的指引，不是让用户自己去填地址。
   */
  async ensureEnvironment() {
    const res = await this.zentao.products();
    if (res.code === 0) return res.rows;
    if (cliMissing(res)) {
      throw new SkillError(
        'cli_missing',
        `${failureMessage(res)} 装好后按 references/setup.md「Agent 执行路径」核对，不要向用户索要禅道地址、账号或密码。`,
      );
    }
    if (credentialProblem(res)) {
      throw new SkillError(
        'not_authenticated',
        `${failureMessage(res)} 让终端用户自己按 references/setup.md 在本机页面里填凭据（connect.mjs），不要在对话里索要密码。`,
      );
    }
    throw new SkillError(
      'zentao_unreachable',
      `${failureMessage(res)} 先确认内网连通（禅道地址在技能包的 config.local.json 里），不要向用户索要地址。`,
    );
  }

  /** 认证自检：入口脚本每次调用都会用本机凭据换一个属于当前账号的令牌。 */
  async login() {
    const res = await this.zentao.products();
    if (res.code === 0) return { ok: true };
    throwIfCredentialProblem(res);
    throw new SkillError('auth_failed', failureMessage(res));
  }

  // ---- 只读 ---------------------------------------------------------

  /** 当前账号可见的产品：后续选产品的候选范围。 */
  async listProducts() {
    const res = await this.zentao.products();
    if (res.code !== 0) return [];
    return res.rows;
  }

  /** 反馈列表：入口脚本用 --all 翻完全部页，投影成 id/标题/状态/负责人。 */
  async scanFeedbacks(productId) {
    const res = await this.zentao.feedbacks(productId);
    if (res.code !== 0) {
      return { items: [], complete: false, error: `读取反馈列表失败：${failureMessage(res)}` };
    }
    return { items: res.rows, complete: true, error: null };
  }

  async listFeedbacks(productId) {
    const { items } = await this.scanFeedbacks(productId);
    return items;
  }

  /** 客户端查重：拉取该产品的反馈 + 标题关键词匹配。 */
  async findDuplicates(productId, title, { threshold = 0.5 } = {}) {
    const { items } = await this.scanFeedbacks(productId);
    return items
      .map((f) => ({ ...f, score: similarity(title, f.title) }))
      .filter((f) => f.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  /** 按编号回读：入口脚本把字段投影成一行 JSON，正文已经剥掉标签。 */
  async readBack(id) {
    const res = await this.zentao.feedback(id);
    const data = res.data;
    if (res.code !== 0 || data?.ok !== true) {
      return { found: false, raw: data, actions: [] };
    }
    return {
      found: true,
      feedback: {
        id: data.id,
        product: data.product,
        title: data.title,
        desc: data.body,
        status: data.status,
        assignedTo: data.assignee || '',
        openedBy: data.openedBy || '',
        reviewedDate: data.reviewedDate || '',
        solution: data.resolution || '',
      },
      status: data.status,
      assignedTo: data.assignee || '',
      actions: (data.actions || []).map((a) => a.action),
      raw: data,
    };
  }

  // ---- 写入 ---------------------------------------------------------

  async submit({ title, desc, type, productId }) {
    if (!FEEDBACK_TYPES.includes(type)) throw new SkillError('bad_type', `未知反馈类型：${type}`);
    // 写入前先把该产品的反馈扫一遍：既是查重，也是「本次新建」的 ID 基线。
    const scan = await this.scanFeedbacks(productId);
    const duplicates = scan.items
      .map((f) => ({ ...f, score: similarity(title, f.title) }))
      .filter((f) => f.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    const approved = await this.confirm({ kind: 'submit', draft: { title, desc, type, productId }, duplicates });
    if (!approved) return { status: 'cancelled', writes: 0, duplicates };

    const res = await this.zentao.createFeedback({ product: Number(productId), title, desc, type });
    throwIfCredentialProblem(res);
    const data = res.data || {};
    if (data.ok === true) {
      const detail = await this.readBack(data.id);
      return {
        status: 'created',
        id: data.id,
        writes: 1,
        detail,
        duplicates,
        // 结论来自查询核实（创建超时后恢复），不是创建回执
        ...(data.verified === 'query' ? { recovered: true } : {}),
      };
    }
    const message = failureMessage(res);
    // 超时/断连后没能在基线之外找到唯一一致的新记录：不重发，报未确认
    if (data.uncertain) {
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      return {
        status: 'unknown',
        reason: candidates.length > 1 ? 'multiple_candidates' : 'no_match',
        writes: 1,
        duplicates,
        candidates,
        message,
      };
    }
    // 单据写进去了但回读对不上：不重建，把现状交回终端用户
    if (data.created) {
      return { status: 'inconsistent', id: data.id, writes: 1, detail: await this.readBack(data.id), duplicates, message };
    }
    // 参数/业务失败：请求被拒绝（usage 连请求都没发），按失败处理，不重试
    return { status: 'failed', writes: res.code === 1 ? 1 : 0, duplicates, message };
  }

  async supplement({ id, addition }) {
    const before = await this.readBack(id);
    if (!before.found) return { status: 'not_found', writes: 0 };
    const original = normalizeNewlines(before.feedback.desc || '');
    const nextDesc = appendDraft(original, `【补充说明 · ${this.stamp()} · 用户口述，AI 整理】\n${addition}`);
    const approved = await this.confirm({ kind: 'supplement', id, original, next: nextDesc });
    if (!approved) return { status: 'cancelled', writes: 0 };

    // 写前复核在入口脚本里做：原文被他人改动时它停手并把现状交回，不覆盖新内容。
    const res = await this.zentao.updateFeedback(id, { desc: nextDesc, expectedBody: original });
    throwIfCredentialProblem(res);
    const data = res.data || {};
    const message = failureMessage(res);
    if (data.ok === true) {
      return {
        status: 'updated',
        id,
        writes: 1,
        detail: await this.readBack(id),
        ...(data.verified === 'query' ? { recovered: true } : {}),
      };
    }
    if (data.conflict) {
      return {
        status: 'conflict',
        needsUserDecision: true,
        writes: 0,
        message,
        current: { desc: data.currentBody, mergedDraft: data.mergedDraft, changed: data.changed },
      };
    }
    if (data.uncertain) {
      return {
        status: 'unknown',
        reason: 'update_unconfirmed',
        id,
        writes: 1,
        detail: await this.readBack(id),
        message,
      };
    }
    if (data.updated) {
      return { status: 'inconsistent', id, writes: 1, detail: await this.readBack(id), message };
    }
    return { status: 'failed', writes: res.code === 1 ? 1 : 0, message };
  }

  // ---- 解释 ---------------------------------------------------------

  /** 事实 / 推断 / 无法确定 三段式。 */
  async explain(id) {
    const detail = await this.readBack(id);
    if (!detail.found) return { status: 'not_found', facts: [], inferences: [], unknown: [] };
    const fb = detail.feedback;
    const actions = detail.raw?.actions || [];

    const facts = [`当前状态：${fb.status || '未知'}`, `负责人：${fb.assignedTo || '未指派'}`];
    for (const a of actions) {
      facts.push(`${a.date || ''} ${a.actor || ''} ${a.action || ''}${a.comment ? `：${a.comment}` : ''}`);
    }

    const inferences = [];
    if (fb.reviewedDate && !fb.solution) {
      inferences.push('评审动作已发生，但结论字段仍为空，推断评审尚未给出结论（依据：reviewedDate 有值而 solution 为空）');
    }
    if (!fb.version && !fb.plan) {
      inferences.push('禅道里没有版本/计划记录，推断尚未进入排期（依据：version 与 plan 均为空）');
    }

    const unknown = [];
    if (!fb.version && !fb.plan) {
      unknown.push('未排期的原因：接口没有该字段，也没有可引用的评论说明');
    }
    if (!fb.solution) {
      unknown.push('最终处理结论：solution 为空');
    }

    return { status: 'ok', facts, inferences, unknown, detail };
  }
}

/**
 * 选品规则：用户这次明说的 > 本机默认 > 随包默认（需确认）> 追问一次。
 * 两个默认都只是默认值；不可见时如实说明，不静默换一个产品建单。
 *
 * @param {{stated?: {id: number, name?: string}|null, defaultProduct?: {id: number, name?: string}|null, packageDefault?: {id: number, name?: string}|null, visibleProducts?: Array<{id: number, name?: string}>}} input
 */
export function pickProduct({
  stated = null,
  defaultProduct = null,
  packageDefault = null,
  visibleProducts = [],
} = {}) {
  const visibleIds = new Set((visibleProducts || []).map((p) => Number(p.id)));
  const isVisible = (p) => p && visibleIds.has(Number(p.id));
  const label = (p) => p?.name || p?.id;

  if (stated) {
    if (!isVisible(stated)) {
      return {
        status: 'not_visible',
        source: 'stated',
        product: stated,
        message: `你的账号看不到 ${label(stated)}，这条暂时无法提交到该产品，请找管理员开权限或换一个产品`,
      };
    }
    return { status: 'stated', source: 'stated', product: stated };
  }

  // 本机默认：用户自己设的，直接用，不再问。
  if (defaultProduct) {
    if (!isVisible(defaultProduct)) {
      return {
        status: 'not_visible',
        source: 'local',
        product: defaultProduct,
        askUser: true,
        message: `你设的默认产品 ${label(defaultProduct)} 当前账号看不到，请找管理员开权限或换一个`,
      };
    }
    return { status: 'default', source: 'local', product: defaultProduct };
  }

  // 随包默认：分发者预置的，不是用户自己选的，每次使用都要确认一句。
  if (packageDefault) {
    if (!isVisible(packageDefault)) {
      return {
        status: 'not_visible',
        source: 'package',
        product: packageDefault,
        askUser: true,
        message: `随包默认的 ${label(packageDefault)} 当前账号看不到，请找管理员开权限或换一个`,
      };
    }
    return {
      status: 'package_default',
      source: 'package',
      product: packageDefault,
      needsConfirm: true,
      message: `默认记到 ${label(packageDefault)} 对吗？`,
    };
  }

  return { status: 'ask', askUser: true };
}

/**
 * 缺陷单流程的参考实现：与反馈单同一套硬约束，字段名与正文载体不同。
 */
export class DefectAssistant extends FeedbackAssistant {
  // ---- 只读 ---------------------------------------------------------

  async scanBugs(productId) {
    const res = await this.zentao.bugs(productId);
    if (res.code !== 0) {
      return { items: [], complete: false, error: `读取缺陷列表失败：${failureMessage(res)}` };
    }
    return { items: res.rows, complete: true, error: null };
  }

  /** 缺陷查重：拉取该产品的缺陷 + 标题关键词匹配。 */
  async findBugDuplicates(productId, title, { threshold = 0.5 } = {}) {
    const { items } = await this.scanBugs(productId);
    return items
      .map((b) => ({ ...b, score: similarity(title, b.title) }))
      .filter((b) => b.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  async readBackBug(id) {
    const res = await this.zentao.bug(id);
    const data = res.data;
    if (res.code !== 0 || data?.ok !== true) {
      return { found: false, raw: data, actions: [] };
    }
    return {
      found: true,
      bug: {
        id: data.id,
        product: data.product,
        title: data.title,
        steps: data.body,
        status: data.status,
        assignedTo: data.assignee || '',
        openedBy: data.openedBy || '',
        severity: data.severity,
        pri: data.pri,
        openedBuild: data.openedBuild,
        resolvedDate: data.processedDate || '',
        resolution: data.resolution || '',
      },
      status: data.status,
      assignedTo: data.assignee || '',
      openedBy: data.openedBy || '',
      actions: (data.actions || []).map((a) => a.action),
      raw: data,
    };
  }

  // ---- 写入 ---------------------------------------------------------

  async submitBug({ title, steps, productId, openedBuild = ['trunk'], severity = 3, pri = 3, type = 'others', project, assignedTo }) {
    if (!BUG_TYPES.includes(type)) throw new SkillError('bad_type', `未知缺陷类型：${type}`);
    // 写入前先把该产品的缺陷扫一遍：既是查重，也是「本次新建」的 ID 基线。
    const scan = await this.scanBugs(productId);
    const duplicates = scan.items
      .map((b) => ({ ...b, score: similarity(title, b.title) }))
      .filter((b) => b.score >= 0.5)
      .sort((a, b) => b.score - a.score);

    const draft = { title, steps, productId, openedBuild, severity, pri, type, project };
    const approved = await this.confirm({ kind: 'submitBug', draft, duplicates });
    if (!approved) return { status: 'cancelled', writes: 0, duplicates };

    // 载荷里没有 assignedTo = 缺省跟产品 QD 走（由禅道侧按产品指派）；
    // 终端用户指名时才写这个字段。
    const payload = { productID: Number(productId), title, steps, openedBuild, severity, pri, type };
    if (assignedTo !== undefined) payload.assignedTo = assignedTo;
    if (project !== undefined && project !== null) payload.project = Number(project);

    const res = await this.zentao.createBug(payload);
    throwIfCredentialProblem(res);
    const data = res.data || {};
    if (data.ok === true) {
      const detail = await this.readBackBug(data.id);
      return {
        status: 'created',
        id: data.id,
        writes: 1,
        detail,
        duplicates,
        ...(data.verified === 'query' ? { recovered: true } : {}),
      };
    }
    const message = failureMessage(res);
    if (data.uncertain) {
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      return {
        status: 'unknown',
        reason: candidates.length > 1 ? 'multiple_candidates' : 'no_match',
        writes: 1,
        duplicates,
        candidates,
        message,
      };
    }
    if (data.created) {
      return { status: 'inconsistent', id: data.id, writes: 1, detail: await this.readBackBug(data.id), duplicates, message };
    }
    return { status: 'failed', writes: res.code === 1 ? 1 : 0, duplicates, message };
  }

  async supplementBug({ id, addition }) {
    const before = await this.readBackBug(id);
    if (!before.found) return { status: 'not_found', writes: 0 };
    const original = String(before.bug.steps || '');
    // 草稿形态固定（见 references/workflow.md F4）：原文 + 分隔行 + 标注 + 追加段落
    const nextSteps = appendDraft(original, `【补充说明 · ${this.stamp()} · 用户口述，AI 整理】\n${addition}`);
    const approved = await this.confirm({ kind: 'supplementBug', id, original, next: nextSteps });
    if (!approved) return { status: 'cancelled', writes: 0 };

    // 写前复核在入口脚本里做：正文被他人改动时它停手并把现状交回，不覆盖新内容。
    const res = await this.zentao.updateBug(id, { steps: nextSteps, expectedBody: original });
    throwIfCredentialProblem(res);
    const data = res.data || {};
    const message = failureMessage(res);
    if (data.ok === true) {
      return {
        status: 'updated',
        id,
        writes: 1,
        detail: await this.readBackBug(id),
        ...(data.verified === 'query' ? { recovered: true } : {}),
      };
    }
    if (data.conflict) {
      return {
        status: 'conflict',
        needsUserDecision: true,
        writes: 0,
        message,
        current: { steps: data.currentBody, mergedDraft: data.mergedDraft, changed: data.changed },
      };
    }
    if (data.uncertain) {
      return {
        status: 'unknown',
        reason: 'update_unconfirmed',
        id,
        writes: 1,
        detail: await this.readBackBug(id),
        message,
      };
    }
    if (data.updated) {
      return { status: 'inconsistent', id, writes: 1, detail: await this.readBackBug(id), message };
    }
    return { status: 'failed', writes: res.code === 1 ? 1 : 0, message };
  }

  // ---- 解释 ---------------------------------------------------------

  async explainBug(id) {
    const detail = await this.readBackBug(id);
    if (!detail.found) return { status: 'not_found', facts: [], inferences: [], unknown: [] };
    const bug = detail.bug;
    const actions = detail.raw?.actions || [];

    const facts = [`当前状态：${bug.status || '未知'}`, `负责人：${bug.assignedTo || '未指派'}`];
    for (const a of actions) {
      facts.push(`${a.date || ''} ${a.actor || ''} ${a.action || ''}${a.comment ? `：${a.comment}` : ''}`);
    }

    const inferences = [];
    if (bug.assignedTo && !bug.assignedDate) {
      inferences.push('缺陷已指派负责人，但看不到指派时间，推断刚指派不久（依据：assignedTo 有值而 assignedDate 为空）');
    }
    if (!bug.resolvedDate && !bug.closedDate) {
      inferences.push('没有解决与关闭记录，推断仍在处理中（依据：resolvedDate 与 closedDate 均为空）');
    }

    const unknown = [];
    if (!bug.resolvedDate && !bug.closedDate) {
      unknown.push('预计修复时间：接口没有该字段，也没有可引用的评论说明');
    }
    if (!bug.resolution) {
      unknown.push('最终处理结论：resolution 为空');
    }

    return { status: 'ok', facts, inferences, unknown, detail };
  }
}
