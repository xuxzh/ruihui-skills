// 传图这条路径的外部行为：只看脚本对禅道说了什么、Agent 拿到什么。
// 运行：node --test tests/zentao-cli-file.mjs
//
// 关注点：
//   - 图片挂在**已存在的**单据上，缺陷单与反馈单两种 object-type 都能挂
//   - 输出一行 JSON：文件标识 + 图片引用（指向附件，不是内联数据）+ 挂载对象
//   - 图片路径相对**命令执行目录**解析；脚本不产生临时文件，用户给的图片不删
//   - 上传失败如实报错（退出码非 0），不改用文字描述假装图片已经放上去
//   - 上传返回里没有文件标识 / 结果不确定（超时）→ 报失败或未确认，不重传
//   - 顺序固定：先建单 → 再传图 → 再更新正文 → 回读核对
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
const FILES_PATH = '/api.php/v2/files';

// 1x1 的 PNG：够真，也不撑大仓库
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFRIQAAAABJRU5ErkJggg==';

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
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它传图，装好再跑这份测试';

// 替身 CLI：把收到的命令行参数记下来，再按 RH_CLI_SHIM_MODE 决定是给固定响应还是转给真的禅道 CLI。
// 这样能测「CLI 给了看不懂的响应」这类分支，也能直接看到「脚本对 CLI 说了什么」。
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.RH_CLI_SHIM_LOG) fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.RH_CLI_SHIM_MODE || 'forward';
if (mode === 'no-id') {
  process.stdout.write(JSON.stringify({ ok: true, data: {}, meta: {} }) + '\\n');
  process.exit(0);
}
if (mode === 'timeout') {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: '5001', message: '请求超时' } }) + '\\n');
  process.exit(1);
}
const { execFileSync } = require('node:child_process');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

const BUG_STEPS = ['<p><strong>[步骤]</strong></p>', '<p>1. 打开「设备管理」</p>', '<p>2. 点「导出」</p>'].join('');

/** 一张真实存在的图片文件（默认写在临时目录里）。 */
function writeImage(dir, name = 'shot.png') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(PNG_BASE64, 'base64'));
  return file;
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
// 同步等待会卡住当前事件循环，假服务就没人应答了。cwd 决定图片相对路径的基准。
function runScript(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ...env }, cwd: cwd || ROOT },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** 起假服务 + 隔离的本机配置（凭据、随包配置都落在临时目录里）。 */
async function withMock(overrides, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-file-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url, bugAssignee: '' }));
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: writeCredentials(dir),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
  };
  try {
    await fn({ server, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function uploads(server) {
  return server.state.calls.filter((call) => call.method === 'POST' && call.path === FILES_PATH);
}

/** multipart 表单里某个字段的值：只看假服务收到的原文，不猜脚本内部怎么拼。 */
function formField(raw, name) {
  const match = String(raw).match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  return match ? match[1] : '';
}

function uploadedFilename(raw) {
  const match = String(raw).match(/name="file"; filename="([^"]*)"/);
  return match ? match[1] : '';
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

/** 起一个替身 CLI，返回它的 argv 日志路径与环境变量。 */
function useShim(dir, env, mode) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
  fs.writeFileSync(shim, SHIM_SOURCE);
  fs.chmodSync(shim, 0o755);
  const argvLog = path.join(dir, 'cli-argv.log');
  return {
    argvLog,
    env: {
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RH_CLI_SHIM_LOG: argvLog,
      RH_CLI_SHIM_MODE: mode,
      RH_CLI_REAL: ZENTAO_CLI,
    },
  };
}

// ---------------------------------------------------------------- 传图：成功路径

test('F01 缺陷单传图：图片挂到已存在的缺陷单上，输出文件标识与图片引用', { skip: NEEDS_CLI }, async () => {
  // 单据先存在（先建单、再传图）：缺陷单 #1900 已在假服务里
  const bugs = new Map([[1900, { id: 1900, title: '设备列表导出无响应', product: 101, status: 'active', steps: BUG_STEPS }]]);
  await withMock({ bugs, nextFileId: 6530 }, async ({ server, env, dir }) => {
    const image = writeImage(dir);
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'],
      env,
    );
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'file');
    assert.equal(result.fileId, 6530);
    assert.equal(result.objectType, 'bug');
    assert.equal(result.objectId, 1900);
    assert.equal(result.extension, 'png');
    assert.equal(
      result.reference,
      '<img src="/index.php?m=file&f=read&t=png&fileID=6530" alt="file-read-6530.png" />',
    );

    // 上传请求本身就是挂载动作：object-type / object-id 必须与目标单据一致
    const [upload] = uploads(server);
    assert.ok(upload, '要向 /api.php/v2/files 发一次上传');
    assert.equal(uploads(server).length, 1);
    assert.equal(formField(upload.body, 'objectType'), 'bug');
    assert.equal(formField(upload.body, 'objectID'), '1900');
    assert.equal(uploadedFilename(upload.body), 'shot.png');
    // 传图不许顺手建单：单据已经存在
    assert.equal(server.state.calls.filter((call) => call.method === 'POST' && call.path === '/api.php/v2/bugs').length, 0);
  });
});

test('F02 反馈单传图：--object-type feedback 透传给服务端并绑定成功', { skip: NEEDS_CLI }, async () => {
  const feedbacks = new Map([[900, { id: 900, title: '导出失败', product: 101, status: 'active', desc: '点了没反应' }]]);
  await withMock({ feedbacks, nextFileId: 6531 }, async ({ server, env, dir }) => {
    const image = writeImage(dir, 'shot.png');
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'feedback', '--object-id', '900'],
      env,
    );
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.fileId, 6531);
    assert.equal(result.objectType, 'feedback');
    assert.equal(result.objectId, 900);
    assert.match(result.reference, /fileID=6531\b/);

    const [upload] = uploads(server);
    assert.equal(formField(upload.body, 'objectType'), 'feedback');
    assert.equal(formField(upload.body, 'objectID'), '900');
  });
});

test('F03 图片引用指向附件：相对路径 + 小写扩展名，不用内联数据', { skip: NEEDS_CLI }, async () => {
  await withMock({ nextFileId: 6530 }, async ({ env, dir }) => {
    const image = writeImage(dir, 'ScreenShot.PNG');
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'],
      env,
    );
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.extension, 'png', '扩展名要小写、不带点');
    assert.match(result.reference, /^<img src="\/index\.php\?m=file&f=read&t=png&fileID=6530" alt="file-read-6530\.png" \/>$/);
    // 引用指向禅道里的附件，不是把图片塞进正文
    assert.ok(!/base64/.test(stdout), `输出里不该出现 base64：${stdout}`);
    assert.ok(!/data:/.test(stdout), `输出里不该出现 data: 内联数据：${stdout}`);
  });
});

test('F04 相对路径按命令执行目录解析：脚本不产生临时文件，用户给的图片不删', { skip: NEEDS_CLI }, async () => {
  await withMock({ nextFileId: 6532 }, async ({ server, env, dir }) => {
    // 调用者在别的目录里跑，图片用的是相对路径
    const workdir = path.join(dir, '工作目录');
    fs.mkdirSync(workdir);
    writeImage(workdir, 'shot.png');
    const before = fs.readdirSync(workdir).sort();

    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', 'shot.png', '--object-type', 'bug', '--object-id', '1900'],
      env,
      workdir,
    );
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.fileId, 6532);
    const [upload] = uploads(server);
    assert.equal(uploadedFilename(upload.body), 'shot.png', '传上去的就是执行目录里的那张图');
    assert.ok(fs.existsSync(path.join(workdir, 'shot.png')), '用户给的图片不许删');
    assert.deepEqual(fs.readdirSync(workdir).sort(), before, '传图不留临时文件');
  });
});

// ---------------------------------------------------------------- 传图：失败路径

test('F05 服务端拒绝上传：如实报错，不改用文字描述假装图片已放上去', { skip: NEEDS_CLI }, async () => {
  await withMock({ failPaths: [FILES_PATH] }, async ({ server, env, dir }) => {
    const image = writeImage(dir);
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'],
      env,
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：传图失败/m);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.ok(!result.reference, '失败时不能给出图片引用');
    assert.equal(uploads(server).length, 1, '失败也不重传');
  });
});

test('F06 上传返回里没有文件标识：按失败处理，不给图片引用', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const image = writeImage(dir);
    const shim = useShim(dir, env, 'no-id');
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'],
      shim.env,
    );
    assert.equal(code, 1);
    assert.match(stderr, /没有文件标识/);
    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.ok(!result.reference, '没有文件标识就不能给出引用');
  });
});

test('F07 上传结果不确定（超时）：报未确认，不重传', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const image = writeImage(dir);
    const shim = useShim(dir, env, 'timeout');
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'],
      shim.env,
    );
    assert.equal(code, 1);
    assert.match(stderr, /传图结果不确定/);
    assert.ok(!/没传上去/.test(stderr), '结果不确定时不能说「没传上去」');

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);

    const argvList = fs
      .readFileSync(shim.argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(argvList.length, 1, '结果不确定也不重传');
    // 走的是官方 CLI 的 file create，参数就是这三个
    assert.deepEqual(argvList[0].slice(argvList[0].indexOf('create')), [
      'create',
      '--file',
      image,
      '--object-type',
      'bug',
      '--object-id',
      '1900',
    ]);
  });
});

test('F08 图片文件找不到：本地就报错，一个上传请求都不发', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const { code, stdout, stderr } = await runScript(
      ['file-create', '--file', path.join(dir, 'nope.png'), '--object-type', 'bug', '--object-id', '1900'],
      env,
    );
    assert.equal(code, 1);
    assert.match(stderr, /^错误：找不到图片文件：/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(uploads(server).length, 0);
  });
});

test('F09 用法错误：object-type 只认 bug 与 feedback，缺参数报用法', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const image = writeImage(dir);
    const story = await runScript(['file-create', '--file', image, '--object-type', 'story', '--object-id', '1'], env);
    assert.equal(story.code, 2);
    assert.match(story.stderr, /^错误：用法：.*file-create --file/);

    const missing = await runScript(['file-create', '--file', image, '--object-type', 'bug'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /单据 ID 是数字/);

    const bogus = await runScript(['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900', '--bogus', '1'], env);
    assert.equal(bogus.code, 2);
    assert.equal(uploads(server).length, 0);
  });
});

// ---------------------------------------------------------------- 整条顺序

test('F10 顺序固定：先建单 → 再传图 → 再更新正文，回读能核到追加段落与图片引用', { skip: NEEDS_CLI }, async () => {
  await withMock({ nextFileId: 6530 }, async ({ server, env, dir }) => {
    // 1. 建单
    const bugFile = writePayload(dir, {
      productID: 101,
      title: '设备列表导出按钮点击后无响应',
      openedBuild: ['trunk'],
      severity: 3,
      pri: 3,
      type: 'codeerror',
      steps: BUG_STEPS,
    });
    const created = await runScript(['bug-create', '--payload-file', bugFile], env);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(singleLineJson(created.stdout).id, 1900);

    // 2. 传图：挂在刚建好的缺陷单上
    const image = writeImage(dir);
    const uploaded = await runScript(['file-create', '--file', image, '--object-type', 'bug', '--object-id', '1900'], env);
    assert.equal(uploaded.code, 0, uploaded.stderr);
    const fileResult = singleLineJson(uploaded.stdout);
    assert.equal(fileResult.fileId, 6530);

    // 3. 更新正文：图片引用写进追加段落（原文部分必须与 expectedBody 逐字一致）
    const appended = ['────', '【补充说明 · 截图 1】', fileResult.reference].join('\n');
    const updateFile = writePayload(dir, {
      steps: `${BUG_STEPS}\n\n${appended}`,
      expectedBody: BUG_STEPS,
    });
    const updated = await runScript(['bug-update', '--id', '1900', '--payload-file', updateFile], env);
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(singleLineJson(updated.stdout).updated, true);

    // 4. 回读核对：正文里是图片引用（指向附件），附件挂在目标单据上
    assert.match(server.state.bugs.get(1900).steps, /<img src="\/index\.php\?m=file&f=read&t=png&fileID=6530"/);
    const [upload] = uploads(server);
    assert.equal(formField(upload.body, 'objectType'), 'bug');
    assert.equal(formField(upload.body, 'objectID'), '1900');

    // 顺序：建单 → 传图 → 更新，不能颠倒（上传要挂在已存在的单据上）
    const order = server.state.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.path === '/api.php/v2/bugs' || call.path === FILES_PATH || call.path === '/api.php/v2/bugs/1900');
    const createAt = order.find(({ call }) => call.method === 'POST' && call.path === '/api.php/v2/bugs')?.index;
    const uploadAt = order.find(({ call }) => call.method === 'POST' && call.path === FILES_PATH)?.index;
    const updateAt = order.find(({ call }) => call.method === 'PUT' && call.path === '/api.php/v2/bugs/1900')?.index;
    assert.ok(createAt < uploadAt, '先建单再传图');
    assert.ok(uploadAt < updateAt, '先传图再更新正文');

    // Agent 的回读视图：追加段落的说明文字看得到（HTML 标签会被查询输出剥掉）
    const readback = await runScript(['bug', '--id', '1900'], env);
    assert.equal(readback.code, 0, readback.stderr);
    assert.match(singleLineJson(readback.stdout).body, /【补充说明 · 截图 1】/);
  });
});
