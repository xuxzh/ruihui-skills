import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS } from './mock-zentao-api.mjs';
import { findZentaoCli, installCliShim, runEntryScript, withMockApi } from './zentao-client.mjs';

const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本靠官方禅道 CLI 取数写数；没装就别假装测过
const ZENTAO_CLI = findZentaoCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

// 丢响应的替身 CLI：更新请求照发（服务端会落库），但把响应丢掉，模拟「结果不明」。
const LOSSY_SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(argv) + '\\n');
if (argv.includes('update')) {
  execFileSync(process.env.RH_CLI_REAL, argv, { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
  process.stdout.write('{ 这不是合法 JSON');
  process.exit(0);
}
execFileSync(process.env.RH_CLI_REAL, argv, { stdio: 'inherit', env: process.env });
`;

/**
 * 起假服务 + 隔离的本机配置：凭据、config.local.json（随包默认）、preferences.json（本机偏好）
 * 都落在临时目录里，测试不碰开发者本机的真实配置。
 */
const withMock = (opts, fn) =>
  withMockApi({ tag: 'rh-cli-append', config: {}, preferences: {}, ...opts }, fn);

// 追加草稿的形态：原文 + 分隔行 + 标注 + 追加段落（与 references/workflow.md F4 一致）
const SEPARATOR = '──────────────';
const ANNOTATION = '【补充说明 · 2026-11-20 · 用户口述，AI 整理】';
const ADDITION = '补充：必须先选中至少一行设备，点「导出」才复现；不选直接点没反应。';

const FEEDBACK_BODY = '【业务场景】\n仓管每天下班前导出对账。\n【实际结果】\n导出无响应';
const BUG_STEPS = '<p>【业务场景】</p><p>仓管每天下班前导出对账。</p><p>【实际结果】</p><p>导出无响应</p>';

/** 终端用户追加说明时，Agent 拼出来的草稿。 */
function appendDraft(original, addition = ADDITION) {
  return `${original}\n\n${SEPARATOR}\n${ANNOTATION}\n${addition}`;
}

function seedFeedback(overrides = {}) {
  return {
    id: 900,
    title: '设备列表导出按钮点击后无响应',
    status: 'active',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: '',
    product: 101,
    desc: FEEDBACK_BODY,
    type: 'advice',
    feedbackBy: ACCOUNT,
    actions: [{ id: 9000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
    ...overrides,
  };
}

function seedBug(overrides = {}) {
  return {
    id: 1900,
    title: '设备列表导出按钮点击后无响应',
    status: 'active',
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    assignedTo: '',
    product: 101,
    steps: BUG_STEPS,
    severity: '3',
    pri: '3',
    type: 'codeerror',
    openedBuild: ['trunk'],
    project: 0,
    execution: 0,
    actions: [{ id: 19000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
    ...overrides,
  };
}

function writePayload(dir, payload) {
  const file = path.join(dir, `payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

/** 假服务收到的更新请求（禅道更新没有幂等键，这个数量就是「发了几次」）。 */
function updates(server, path) {
  return server.state.calls.filter((call) => call.method === 'PUT' && call.path === path);
}

/** 假服务读这条单据的次数（写前复核那次 + 回读那次；禅道 CLI 的 autoFill 自己也会读一次）。 */
function reads(server, path) {
  return server.state.calls.filter((call) => call.method === 'GET' && call.path === path);
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

/** 归一化：剥标签（缺陷单 steps）、实体、空白与换行。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== ''))
    .join('\n')
    .trim();
}

test('A01 反馈单补充说明：只发一次更新，回读正文 = 原文 + 分隔行 + 标注 + 追加段落，流水新增「编辑」', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'feedback');
    assert.equal(result.id, 900);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'readback');
    assert.deepEqual(result.newActions, ['edited'], '操作流水里要能看到本次新增的「编辑」');

    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 1, '更新请求只能发一次');
    const stored = server.state.feedbacks.get(900);
    assert.equal(
      normalize(stored.desc),
      normalize(appendDraft(FEEDBACK_BODY)),
      '回读正文要是完整预期正文：原文保留 + 分隔行 + 标注 + 追加段落',
    );
    assert.ok(stored.desc.startsWith(FEEDBACK_BODY), '原文要原样保留在前面');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');
  });
});

test('A02 缺陷单补充说明：原文的 HTML 原样保留，追加段落单独标出来', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      title: '设备列表导出按钮点击后无响应',
      // 草稿里的原文是用户看到的那份纯文本；写进去的正文要把服务端那份 HTML 原样保留
      steps: appendDraft(normalize(BUG_STEPS)),
      expectedBody: normalize(BUG_STEPS),
    });
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'bug');
    assert.equal(result.id, 1900);
    assert.deepEqual(result.newActions, ['edited']);

    assert.equal(updates(server, '/api.php/v2/bugs/1900').length, 1, '更新请求只能发一次');
    const stored = server.state.bugs.get(1900);
    assert.ok(stored.steps.startsWith(BUG_STEPS), '缺陷单原文的 HTML 要原样保留');
    assert.equal(normalize(stored.steps), normalize(appendDraft(normalize(BUG_STEPS))), '回读正文要是完整预期正文');
  });
});

test('A03 写前复核发现原文变了：停手不写入，把当前原文与重新合并后的草稿交回用户', { skip: NEEDS_CLI }, async () => {
  const changed = `${FEEDBACK_BODY}\n（有人先补了一句）`;
  await withMock({ feedbacks: new Map([[900, seedFeedback({ desc: changed })]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.notEqual(code, 0, '停手要非 0 退出');
    assert.match(stderr, /^错误：.*被改过/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(result.changed, ['正文']);
    assert.equal(result.currentBody, changed, '要给出当前的原文');
    assert.equal(result.currentBodyText, normalize(changed));
    assert.equal(
      normalize(result.mergedDraft),
      normalize(appendDraft(changed)),
      '要给出按当前原文重新合并后的草稿',
    );

    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 0, '复核没过就不许写');
    assert.equal(server.state.feedbacks.get(900).desc, changed, '单据不能被动过');
  });
});

test('A04 写前复核发现标题被改了：同样停手不写入', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback({ title: '别人改过的标题' })]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stdout } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.notEqual(code, 0);

    const result = singleLineJson(stdout);
    assert.equal(result.conflict, true);
    assert.deepEqual(result.changed, ['标题']);
    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 0, '复核没过就不许写');
  });
});

test('A05 流水里本次没有新增「编辑」（历史上有过 edited）：回读核对不通过，不重放更新', { skip: NEEDS_CLI }, async () => {
  const history = [
    { id: 9000, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' },
    { id: 9001, action: 'edited', actor: ACCOUNT, date: '2026-11-21 10:00:00', comment: '' },
  ];
  await withMock(
    { noopUpdate: true, feedbacks: new Map([[900, seedFeedback({ actions: history })]]) },
    async ({ server, env, dir }) => {
      const file = writePayload(dir, {
        product: 101,
        title: '设备列表导出按钮点击后无响应',
        desc: appendDraft(FEEDBACK_BODY),
        expectedBody: FEEDBACK_BODY,
      });
      const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
      assert.equal(code, 1);
      assert.match(stderr, /编辑/);

      const result = singleLineJson(stdout);
      assert.equal(result.ok, false);
      assert.equal(result.updated, true, '单据已经写进去了，状态要交代清楚');
      assert.ok(result.mismatches.includes('操作流水里本次新增的「编辑」'), '历史上存在过 edited 不算证据');
      assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 1, '不重放更新');
    },
  );
});

test('A06 正文不进命令行参数：更新经文件、以 --data @<路径> 交给 CLI', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const shim = installCliShim(dir, ZENTAO_CLI);
    const { code, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], { ...env, ...shim.env });
    assert.equal(code, 0, stderr);

    const argvList = shim.calls();
    const updateArgv = argvList.find((argv) => argv.includes('update'));
    assert.ok(updateArgv, '应该调起过 feedback update');
    assert.equal(updateArgv[updateArgv.indexOf('--data') + 1], `@${file}`);
    for (const argv of argvList) {
      const joined = argv.join(' ');
      assert.ok(!joined.includes('必须先选中至少一行设备'), `正文不该出现在命令行参数里：${joined}`);
      assert.ok(!joined.includes('仓管每天下班前导出对账'), `正文不该出现在命令行参数里：${joined}`);
    }
  });
});

test('A07 结果不明（响应丢了）：只读核实，核实到写进去了就按成功交付，且不重放更新', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const shim = installCliShim(dir, ZENTAO_CLI, { source: LOSSY_SHIM_SOURCE });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], {
      ...env,
      ...shim.env,
    });
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'query', '结论来自只读核实，不是更新回执');

    const argvList = shim.calls();
    const updateArgvs = argvList.filter((argv) => argv.includes('update'));
    assert.equal(updateArgvs.length, 1, '结果不明也不能重放更新');
    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 1);
  });
});

test('A08 载荷缺 expectedBody：一个更新请求都不发，错误点名缺哪项', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /expectedBody/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 0);
  });
});

test('A09 草稿里没有分隔行：报错说明草稿形态，不写入', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: `${FEEDBACK_BODY}\n${ADDITION}`,
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /分隔行/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 0);
  });
});

test('A10 回读对不上（服务端没生效）：报不一致，不重放更新', { skip: NEEDS_CLI }, async () => {
  await withMock(
    { noopUpdate: true, feedbacks: new Map([[900, seedFeedback()]]) },
    async ({ server, env, dir }) => {
      const file = writePayload(dir, {
        product: 101,
        title: '设备列表导出按钮点击后无响应',
        desc: appendDraft(FEEDBACK_BODY),
        expectedBody: FEEDBACK_BODY,
      });
      const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
      assert.equal(code, 1);
      assert.match(stderr, /回读核对没通过/);

      const result = singleLineJson(stdout);
      assert.equal(result.ok, false);
      assert.ok(result.mismatches.includes('正文'));
      assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 1, '不重放更新');
      assert.ok(reads(server, '/api.php/v2/feedbacks/900').length >= 2, '写前复核与回读各读一次');
    },
  );
});

test('A11 没给 --id 或 --payload-file：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const noId = await runEntryScript(['feedback-update', '--payload-file', file], env);
    assert.equal(noId.code, 2);
    assert.match(noId.stderr, /^错误：用法：.*feedback-update --id/);

    const noFile = await runEntryScript(['feedback-update', '--id', '900'], env);
    assert.equal(noFile.code, 2);
    assert.match(noFile.stderr, /^错误：用法：.*feedback-update/);

    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('A12 带图更新：载荷指定追加段落的标签「截图 1」，正文 = 原文 + 分隔行 + 标签段 + 图片引用', { skip: NEEDS_CLI }, async () => {
  const reference = '<img src="/index.php?m=file&f=read&t=png&fileID=6530" alt="file-read-6530.png" />';
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      // 草稿只写原文 + 分隔行 + 图片引用；标签由 appendLabel 给，不必手写「补充说明」
      desc: `${FEEDBACK_BODY}\n\n${SEPARATOR}\n${reference}`,
      expectedBody: FEEDBACK_BODY,
      appendLabel: '截图 1',
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    assert.equal(singleLineJson(stdout).updated, true);

    const stored = server.state.feedbacks.get(900);
    assert.equal(
      stored.desc,
      `${FEEDBACK_BODY}\n\n${SEPARATOR}\n【截图 1】\n${reference}`,
      '追加段落的标签按载荷写，图片引用跟在标签下面',
    );
    assert.ok(stored.desc.startsWith(FEEDBACK_BODY), '图片落在原文之后的追加段落里，原文原样保留');
    assert.ok(!stored.desc.includes('补充说明'), '带图流程的段落标签不该再写成「补充说明」');
  });
});

test('A13 不带 appendLabel：草稿里写的「补充说明」标签原样保留（补充说明流程不变）', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);
    const stored = server.state.feedbacks.get(900);
    assert.equal(stored.desc, `${FEEDBACK_BODY}\n\n${SEPARATOR}\n${ANNOTATION}\n${ADDITION}`);
    assert.ok(!stored.desc.includes('【补充说明】\n'), '不该再补一行默认标签，草稿里的标签就是最终标签');
  });
});

test('A14 appendLabel 写空串：报错说清怎么改，一个更新请求都不发', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
      appendLabel: '  ',
    });
    const { code, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 1);
    assert.match(stderr, /appendLabel/);
    assert.equal(updates(server, '/api.php/v2/feedbacks/900').length, 0, '载荷不对就不该发更新');
  });
});

test('A15 反馈单更新回读没有 actions（真实 CLI 0.4.4 形状）：正文对上就判成功，不凭空要求流水', { skip: NEEDS_CLI }, async () => {
  await withMock({ omitActions: true, feedbacks: new Map([[900, seedFeedback({ actions: undefined })]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: appendDraft(FEEDBACK_BODY),
      expectedBody: FEEDBACK_BODY,
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'readback');
    assert.deepEqual(result.newActions, [], '没有流水时不要凭空造一条');
    assert.equal(normalize(server.state.feedbacks.get(900).desc), normalize(appendDraft(FEEDBACK_BODY)));
  });
});

test('A16 缺陷单更新回读没有 actions（真实 CLI 0.4.4 形状）：正文对上就判成功', { skip: NEEDS_CLI }, async () => {
  await withMock({ omitActions: true, bugs: new Map([[1900, seedBug({ actions: undefined })]]) }, async ({ server, env, dir }) => {
    const file = writePayload(dir, {
      title: '设备列表导出按钮点击后无响应',
      steps: appendDraft(normalize(BUG_STEPS)),
      expectedBody: normalize(BUG_STEPS),
    });
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'readback');
    assert.deepEqual(result.newActions, []);
    assert.equal(normalize(server.state.bugs.get(1900).steps), normalize(appendDraft(normalize(BUG_STEPS))));
  });
});

test('A17 反馈单带图更新：服务端给 <img> 补 onload 属性，正文核对仍要按图片引用判一致', { skip: NEEDS_CLI }, async () => {
  await withMock({ feedbackImageOnload: true, feedbacks: new Map([[900, seedFeedback()]]) }, async ({ server, env, dir }) => {
    const reference = '<img src="/index.php?m=file&f=read&t=png&fileID=6530" alt="file-read-6530.png" />';
    const file = writePayload(dir, {
      product: 101,
      title: '设备列表导出按钮点击后无响应',
      desc: `${FEEDBACK_BODY}\n\n${SEPARATOR}\n${reference}`,
      expectedBody: FEEDBACK_BODY,
      appendLabel: '截图 1',
    });
    const { code, stdout, stderr } = await runEntryScript(['feedback-update', '--id', '900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'readback');
    assert.match(server.state.feedbacks.get(900).desc, /fileID=6530/);
  });
});

test('A18 缺陷单带图更新：图片引用按 fileID 归一，回读正文里看得见', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const reference = '<img src="/index.php?m=file&f=read&t=png&fileID=6530" alt="file-read-6530.png" />';
    const file = writePayload(dir, {
      title: '设备列表导出按钮点击后无响应',
      steps: `${normalize(BUG_STEPS)}\n\n${SEPARATOR}\n${reference}`,
      expectedBody: normalize(BUG_STEPS),
      appendLabel: '截图 1',
    });
    const { code, stdout, stderr } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.match(server.state.bugs.get(1900).steps, /fileID=6530/, '图片引用要落进服务端存的正文');

    // 回读投影：剥标签后图片引用仍在（按 fileID 归一），「图片落在正文里」看得见
    const read = await runEntryScript(['bug', '--id', '1900'], env);
    assert.equal(read.code, 0, read.stderr);
    assert.match(singleLineJson(read.stdout).body, /<img fileID="6530">/);
  });
});

test('A19 缺陷单带图更新：服务端没存住图片引用时，回读核对要报不一致', { skip: NEEDS_CLI }, async () => {
  await withMock({ bugStepsDropImage: true, bugs: new Map([[1900, seedBug()]]) }, async ({ server, env, dir }) => {
    const reference = '<img src="/index.php?m=file&f=read&t=png&fileID=6530" alt="file-read-6530.png" />';
    const file = writePayload(dir, {
      title: '设备列表导出按钮点击后无响应',
      steps: `${normalize(BUG_STEPS)}\n\n${SEPARATOR}\n${reference}`,
      expectedBody: normalize(BUG_STEPS),
      appendLabel: '截图 1',
    });
    const { code, stdout } = await runEntryScript(['bug-update', '--id', '1900', '--payload-file', file], env);
    assert.notEqual(code, 0, '回读核对没过就不能报成功');

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.updated, true, '写是写进去了，但核对没过');
    assert.deepEqual(result.mismatches, ['正文']);
    assert.doesNotMatch(server.state.bugs.get(1900).steps, /fileID=6530/, '服务端确实没存住图片引用');
  });
});
