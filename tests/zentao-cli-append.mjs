// 补充说明（更新单据）这条写入路径的外部行为：只看脚本对禅道说了什么、Agent 拿到什么。
// 运行：node --test tests/zentao-cli-append.mjs
//
// 关注点：
//   - 追加草稿的形态：原文完整保留 + 分隔行 + 标注 + 追加段落，文档与实现一致
//   - 写前复核：确认之后、写入之前再读一次；原文变了就停手，一个更新请求都不发，
//     并把当前原文与重新合并后的草稿交回终端用户
//   - 只发一次更新；正文经文件交给 CLI，正文不进命令行参数
//   - 回读：归一化后逐字比较完整预期正文，并确认操作流水里本次新增了「编辑」
//     （历史上存在过 edited 不算证据）
//   - 结果不明（响应丢了）→ 只读核实，不重放更新
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

// 入口脚本靠官方禅道 CLI 取数写数；没装就别假装测过
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

const ZENTAO_CLI = findCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

// 替身 CLI：把收到的命令行参数记下来，再原样交给真的禅道 CLI。
// 这样能直接看到「脚本对 CLI 说了什么」，而不必猜脚本内部怎么拼参数。
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

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

function writeCredentials(dir) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${ACCOUNT}\nZENTAO_PASSWORD=${PASSWORD}\n`);
  return file;
}

// 入口脚本是子进程；假服务跑在当前进程里，所以必须用异步 execFile——
// 同步等待会卡住当前进程的事件循环，假服务就没人应答了。
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

/**
 * 起假服务 + 隔离的本机配置：
 *   credentials（凭据）、preferences.json（本机偏好）、config.local.json（随包默认）
 * 三份文件都落在临时目录里，测试不碰开发者本机的真实配置。
 */
async function withMock(overrides, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-append-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url }));
  const preferencesFile = path.join(dir, 'preferences.json');
  fs.writeFileSync(preferencesFile, JSON.stringify({}));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: writeCredentials(dir),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
    ZENTAO_PREFERENCES_FILE: preferencesFile,
  };
  try {
    await fn({ server, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runScript(['bug-update', '--id', '1900', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
    const { code, stdout } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
      const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');

    const { code, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], {
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RH_CLI_SHIM_LOG: argvLog,
      RH_CLI_REAL: ZENTAO_CLI,
    });
    assert.equal(code, 0, stderr);

    const argvList = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, LOSSY_SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');

    const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], {
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RH_CLI_SHIM_LOG: argvLog,
      RH_CLI_REAL: ZENTAO_CLI,
    });
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.verified, 'query', '结论来自只读核实，不是更新回执');

    const argvList = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
    const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
    const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
      const { code, stdout, stderr } = await runScript(['feedback-update', '--id', '900', '--payload-file', file], env);
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
    const noId = await runScript(['feedback-update', '--payload-file', file], env);
    assert.equal(noId.code, 2);
    assert.match(noId.stderr, /^错误：用法：.*feedback-update --id/);

    const noFile = await runScript(['feedback-update', '--id', '900'], env);
    assert.equal(noFile.code, 2);
    assert.match(noFile.stderr, /^错误：用法：.*feedback-update/);

    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});
