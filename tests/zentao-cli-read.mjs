// 入口脚本的读路径测试：zentao.mjs 在假禅道 API v2 服务上的外部行为。
// 运行：node --test tests/zentao-cli-read.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 可见产品与项目以投影后的紧凑表格交给 Agent，原始 JSON 不进上下文
//   - 令牌经环境变量注入 CLI 子进程，不进命令行参数、不进 Agent 上下文
//   - 凭据无效、令牌失效、CLI 不在 PATH 时退出码非 0，错误信息可读且不回显凭据
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
// 假服务认可的账号密码：测试写进本机凭据文件，脚本再用它换令牌
const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本要靠官方禅道 CLI 取数；没装就别假装测过
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
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它取数，装好再跑这份测试';

// 替身 CLI：把收到的命令行参数记下来，再原样交给真的禅道 CLI。
// 这样测试能直接看到「脚本对 CLI 说了什么」，而不必猜脚本内部怎么拼参数。
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(process.env.RH_CLI_SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
execFileSync(process.env.RH_CLI_REAL, process.argv.slice(2), { stdio: 'inherit', env: process.env });
`;

function writeCredentials(dir, { account = ACCOUNT, password = PASSWORD } = {}) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${account}\nZENTAO_PASSWORD=${password}\n`);
  return file;
}

// 入口脚本是子进程；假服务跑在当前进程里，所以必须用异步的 execFile——
// 同步等待会把当前进程的事件循环卡住，假服务就没人应答了。
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

async function withMock(overrides, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-read-'));
  const env = { ZENTAO_WEB_URL: server.url, ZENTAO_CREDENTIALS_FILE: writeCredentials(dir) };
  try {
    await fn({ server, env, dir });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('R01 产品列表：只输出 id 与名称的紧凑表格，原始 JSON 不进上下文', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stdout, stderr } = await runScript(['products'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 产品（当前账号可见 2 个；这就是后续选品范围）$/m);
    assert.match(stdout, /^101\t示例产品 A$/m);
    assert.match(stdout, /^102\t示例产品 B$/m);
    // 原始 JSON 的痕迹不该进上下文
    assert.ok(!stdout.includes('recTotal'), '输出里不该有原始 JSON 片段');
    assert.ok(!stdout.includes('{'), '输出里不该有原始 JSON 片段');
    // 读一次就够：列表不该被反复翻页
    assert.equal(server.state.calls.filter((c) => c.path === '/api.php/v2/products').length, 1);
  });
});

test('R02 产品列表走 --all：超过一页也全部列出', { skip: NEEDS_CLI }, async () => {
  const products = Array.from({ length: 25 }, (_, i) => ({ id: 200 + i, name: `批量产品 ${i + 1}`, code: `bulk-${i}`, status: 'normal' }));
  await withMock({ products }, async ({ server, env }) => {
    const { code, stdout } = await runScript(['products'], env);
    assert.equal(code, 0);
    assert.match(stdout, /当前账号可见 25 个/);
    assert.match(stdout, /^224\t批量产品 25$/m);
    const pages = server.state.calls.filter((c) => c.path === '/api.php/v2/products').map((c) => c.query.pageID);
    assert.deepEqual(pages, ['1', '2'], '应该翻到第二页');
  });
});

test('R03 项目列表：可见项目紧凑表格；--product 只留该产品下面的', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env }) => {
    const all = await runScript(['projects'], env);
    assert.equal(all.code, 0);
    assert.match(all.stdout, /^# 项目（可见 3 个，其中进行中 2 个）$/m);
    assert.match(all.stdout, /^13\t示例项目 C\tdoing$/m);

    const one = await runScript(['projects', '--product', '101'], env);
    assert.equal(one.code, 0);
    assert.match(one.stdout, /^# 项目（产品 101 下 2 个，其中进行中 1 个）$/m);
    assert.match(one.stdout, /^11\t示例项目 A\tdoing$/m);
    assert.ok(!one.stdout.includes('示例项目 C'), '不该带出别的产品下的项目');
  });
});

test('R09 参数写错：给用法提示并退出码 2，不查项目', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const bad = await runScript(['projects', '--product', '报表平台'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^错误：用法：/);

    // 写错选项不能悄悄按默认值跑，否则 Agent 会以为筛过了
    const typo = await runScript(['products', '--match', '报表'], env);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /products 不认这些选项：--match/);

    assert.equal(server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/')).length, 0, '参数不对时不该查禅道');
  });
});

test('R04 令牌只走环境变量：CLI 收到的是请求头，命令行参数里没有令牌', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, process.platform === 'win32' ? 'zentao.cmd' : 'zentao');
    fs.writeFileSync(shim, SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
    const argvLog = path.join(dir, 'cli-argv.log');

    const { code, stdout, stderr } = await runScript(['products'], {
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RH_CLI_SHIM_LOG: argvLog,
      RH_CLI_REAL: ZENTAO_CLI,
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^101\t示例产品 A$/m);

    const [token] = [...server.state.tokens.keys()];
    assert.ok(token, '假服务应该发过令牌');
    // 令牌真的到了请求头
    const apiCalls = server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/'));
    assert.ok(apiCalls.length > 0, '应该真的请求过禅道 API');
    for (const call of apiCalls) assert.equal(call.token, token);

    // 但没进命令行参数
    const argvList = fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(argvList.length > 0, 'CLI 应该真的被调起来');
    for (const argv of argvList) assert.ok(!JSON.stringify(argv).includes(token), `令牌不该出现在命令行参数里：${argv.join(' ')}`);

    // 也不进 Agent 上下文
    assert.ok(!stdout.includes(token), '输出里不该出现令牌');
    assert.ok(!stderr.includes(token), '错误里不该出现令牌');
  });
});

test('R05 凭据无效：退出码非 0，错误可读，不回显账号密码', { skip: NEEDS_CLI }, async () => {
  await withMock({ accounts: { [ACCOUNT]: 'another-secret' } }, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['products'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道拒绝了本机凭据/m);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
    assert.ok(!stderr.includes(PASSWORD), '错误里不该回显密码');
    assert.ok(!stdout.includes(PASSWORD), '错误里不该回显密码');
  });
});

test('R06 令牌失效：CLI 报错如实转出，退出码非 0', { skip: NEEDS_CLI }, async () => {
  await withMock({ tokenFails: true }, async ({ env }) => {
    const { code, stdout, stderr } = await runScript(['products'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
  });
});

test('R07 禅道 CLI 不在 PATH：如实报没装，退出码非 0', async () => {
  await withMock({}, async ({ env, dir }) => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const { code, stderr } = await runScript(['products'], { ...env, PATH: empty });
    assert.notEqual(code, 0);
    assert.match(stderr, /找不到 zentao 命令/);
  });
});

test('R08 没有本机凭据：给出可执行的指引，不索要密码', async () => {
  await withMock({}, async ({ env, dir }) => {
    const { code, stdout, stderr } = await runScript(['products'], { ...env, ZENTAO_CREDENTIALS_FILE: path.join(dir, 'missing') });
    assert.equal(code, 1);
    assert.match(stderr, /本机没有禅道接入凭据/);
    assert.match(stderr, /不要在对话里把密码告诉 Agent/);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
  });
});
