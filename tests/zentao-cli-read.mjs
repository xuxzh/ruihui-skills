import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS } from './mock-zentao-api.mjs';
import { findZentaoCli, installCliShim, runEntryScript, withMockApi } from './zentao-client.mjs';

// 假服务认可的账号密码：测试写进本机凭据文件，脚本再用它换令牌
const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

// 入口脚本要靠官方禅道 CLI 取数；没装就别假装测过
const ZENTAO_CLI = findZentaoCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它取数，装好再跑这份测试';

/** 起假服务 + 隔离的本机凭据（配置只覆盖站点地址）。 */
const withMock = (overrides, fn) => withMockApi({ tag: 'rh-cli-read', ...overrides }, fn);

test('R01 产品列表：只输出编号、名称与 QD 的紧凑表格，原始 JSON 不进上下文', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stdout, stderr } = await runEntryScript(['products'], env);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^# 产品（当前账号可见 2 个；这就是后续选品范围）$/m);
    assert.match(stdout, /^101\t示例产品 A\tmock-qd$/m);
    assert.match(stdout, /^102\t示例产品 B\t（空）$/m);
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
    const { code, stdout } = await runEntryScript(['products'], env);
    assert.equal(code, 0);
    assert.match(stdout, /当前账号可见 25 个/);
    assert.match(stdout, /^224\t批量产品 25\t（空）$/m);
    const pages = server.state.calls.filter((c) => c.path === '/api.php/v2/products').map((c) => c.query.pageID);
    assert.deepEqual(pages, ['1', '2'], '应该翻到第二页');
  });
});

test('R03 项目列表：可见项目紧凑表格；--product 只留该产品下面的', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env }) => {
    const all = await runEntryScript(['projects'], env);
    assert.equal(all.code, 0);
    assert.match(all.stdout, /^# 项目（可见 3 个，其中进行中 2 个）$/m);
    assert.match(all.stdout, /^13\t示例项目 C\tdoing$/m);

    const one = await runEntryScript(['projects', '--product', '101'], env);
    assert.equal(one.code, 0);
    assert.match(one.stdout, /^# 项目（产品 101 下 2 个，其中进行中 1 个）$/m);
    assert.match(one.stdout, /^11\t示例项目 A\tdoing$/m);
    assert.ok(!one.stdout.includes('示例项目 C'), '不该带出别的产品下的项目');
  });
});

test('R09 参数写错：给用法提示并退出码 2，不查项目', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const bad = await runEntryScript(['projects', '--product', '报表平台'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^错误：用法：/);

    // 写错选项不能悄悄按默认值跑，否则 Agent 会以为筛过了
    const typo = await runEntryScript(['products', '--match', '报表'], env);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /products 不认这些选项：--match/);

    assert.equal(server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/')).length, 0, '参数不对时不该查禅道');
  });
});

test('R04 令牌只走环境变量：CLI 收到的是请求头，命令行参数里没有令牌', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const shim = installCliShim(dir, ZENTAO_CLI);

    const { code, stdout, stderr } = await runEntryScript(['products'], { ...env, ...shim.env });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^101\t示例产品 A\tmock-qd$/m);

    const [token] = [...server.state.tokens.keys()];
    assert.ok(token, '假服务应该发过令牌');
    // 令牌真的到了请求头
    const apiCalls = server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/'));
    assert.ok(apiCalls.length > 0, '应该真的请求过禅道 API');
    for (const call of apiCalls) assert.equal(call.token, token);

    // 但没进命令行参数
    const argvList = shim.calls();
    assert.ok(argvList.length > 0, 'CLI 应该真的被调起来');
    for (const argv of argvList) assert.ok(!JSON.stringify(argv).includes(token), `令牌不该出现在命令行参数里：${argv.join(' ')}`);

    // 也不进 Agent 上下文
    assert.ok(!stdout.includes(token), '输出里不该出现令牌');
    assert.ok(!stderr.includes(token), '错误里不该出现令牌');
  });
});

test('R05 凭据无效：退出码非 0，错误可读，不回显账号密码', { skip: NEEDS_CLI }, async () => {
  await withMock({ accounts: { [ACCOUNT]: 'another-secret' } }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['products'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道拒绝了本机凭据/m);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
    assert.ok(!stderr.includes(PASSWORD), '错误里不该回显密码');
    assert.ok(!stdout.includes(PASSWORD), '错误里不该回显密码');
  });
});

test('R06 令牌失效：CLI 报错如实转出，退出码非 0', { skip: NEEDS_CLI }, async () => {
  await withMock({ tokenFails: true }, async ({ env }) => {
    const { code, stdout, stderr } = await runEntryScript(['products'], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(JSON.parse(stdout.trim()).ok, false);
  });
});

test('R07 禅道 CLI 不在 PATH：如实报没装，退出码非 0', async () => {
  await withMock({}, async ({ env, dir }) => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const { code, stderr } = await runEntryScript(['products'], { ...env, PATH: empty });
    assert.notEqual(code, 0);
    assert.match(stderr, /找不到 zentao 命令/);
  });
});

test('R08 没有本机凭据：给出可执行的指引，不索要密码', async () => {
  await withMock({}, async ({ env, dir }) => {
    const { code, stdout, stderr } = await runEntryScript(['products'], { ...env, ZENTAO_CREDENTIALS_FILE: path.join(dir, 'missing') });
    assert.equal(code, 1);
    assert.match(stderr, /本机没有禅道接入凭据/);
    assert.match(stderr, /connect\.mjs/, '本机页面是首选入口，用户不必离开对话去开终端');
    assert.match(stderr, /set-credentials\.sh/, '终端脚本仍是兜底，不能丢');
    assert.match(stderr, /不在对话里|不经过对话|不要问/, '仍然不许把密码带进对话');
    assert.equal(JSON.parse(stdout.trim()).ok, false);
  });
});

test('R10 全局旗标：--timeout / --insecure 原样转发给禅道 CLI，所有子命令都能带', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const shim = installCliShim(dir, ZENTAO_CLI);
    const run = (args) => runEntryScript(args, { ...env, ...shim.env });

    // 读子命令带全局旗标：CLI 真的收到了这两个旗标（不是脚本自己吞掉）
    const products = await run(['products', '--timeout', '30000', '--insecure']);
    assert.equal(products.code, 0, products.stderr);
    assert.match(products.stdout, /^101\t示例产品 A\tmock-qd$/m);
    // 别的子命令也能带：全局旗标不是 products 专属
    const bugs = await run(['bugs', '--product', '101', '--timeout', '45000']);
    assert.equal(bugs.code, 0, bugs.stderr);

    const argvList = shim.calls();
    assert.equal(argvList.length, 2, '两次命令各调一次 CLI');
    const [productsArgv, bugsArgv] = argvList;
    assert.ok(productsArgv.includes('--insecure'), `--insecure 应转发给 CLI：${productsArgv.join(' ')}`);
    assert.equal(productsArgv[productsArgv.indexOf('--timeout') + 1], '30000', '--timeout 应带上毫秒数');
    assert.equal(bugsArgv[bugsArgv.indexOf('--timeout') + 1], '45000', '--timeout 在任何子命令上都生效');
    assert.ok(!bugsArgv.includes('--insecure'), '没给 --insecure 就不该转发');
  });
});

test('R11 全局旗标写错：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const bad = await runEntryScript(['products', '--timeout', '30秒'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--timeout 要给毫秒数/);
    assert.equal(server.state.calls.filter((c) => c.path.startsWith('/api.php/v2/')).length, 0, '参数不对时不该查禅道');
  });
});
