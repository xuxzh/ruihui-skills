// connect.mjs（本机写入页）的行为测试：验证走 mock 禅道，不碰真实环境。
// 运行：node --test tests/connect.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockApiState, startMockApi, MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS } from './mock-zentao-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'connect.mjs');
const PASSWORD = MOCK_API_ACCOUNTS[MOCK_API_ACCOUNT];

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-connect-'));
  return { dir, credFile: path.join(dir, '.config', 'rh-zentao', 'credentials'), stateFile: path.join(dir, '.config', 'rh-zentao', 'connect.json') };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 前台起页面（serve），拿到状态文件里的地址；测试完关掉进程。 */
async function withPage(mock, fn, extraEnv = {}) {
  const home = tempHome();
  const env = {
    ...process.env,
    HOME: home.dir,
    ZENTAO_CREDENTIALS_FILE: home.credFile,
    ZENTAO_WEB_URL: mock.url,
    RH_CONNECT_NO_OPEN: '1',
    ...extraEnv,
  };
  delete env.APPDATA;
  const child = spawn(process.execPath, [SCRIPT, 'serve', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  try {
    const page = await waitFor(() => {
      const st = readState(home.stateFile);
      return st && st.status === 'waiting' ? st : null;
    });
    return await fn({ page, env, home, getStderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
  }
}

function post(url, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    }).on('error', reject);
  });
}

test('页面只认带一次性密钥的地址', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page }) => {
      const base = page.url.replace(/\/k\/.*$/, '');
      const bare = await get(`${base}/`);
      assert.equal(bare.status, 404);
      const wrongKey = await get(`${base}/k/${'0'.repeat(32)}`);
      assert.equal(wrongKey.status, 404);
      const ok = await get(page.url);
      assert.equal(ok.status, 200);
      assert.match(ok.text, /name="account"/);
      assert.match(ok.text, /type="password"/);
      assert.match(ok.headers['cache-control'], /no-store/);
    });
  } finally {
    await mock.close();
  }
});

test('填对账号密码：验证、写 0600 凭据、报出可见产品', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page, home }) => {
      const res = await post(page.url, { account: MOCK_API_ACCOUNT, secret: PASSWORD, mode: 'password' });
      assert.equal(res.status, 200, res.text);
      assert.match(res.text, /凭据已写入并验证通过/);
      assert.match(res.text, /2 个/);

      const raw = fs.readFileSync(home.credFile, 'utf8');
      assert.match(raw, new RegExp(`ZENTAO_ACCOUNT=${MOCK_API_ACCOUNT}`));
      assert.match(raw, new RegExp(`ZENTAO_PASSWORD=${PASSWORD}`));
      assert.equal(fs.statSync(home.credFile).mode & 0o777, 0o600, '凭据文件必须是 0600');
      assert.equal(fs.statSync(path.dirname(home.credFile)).mode & 0o777, 0o700, '目录必须是 0700');

      const state = await waitFor(() => {
        const st = readState(home.stateFile);
        return st && st.status === 'done' ? st : null;
      });
      assert.equal(state.account, MOCK_API_ACCOUNT);
      assert.equal(state.productCount, 2);
      assert.deepEqual(state.products.map((p) => p.id), ['101', '102']);
    });
  } finally {
    await mock.close();
  }
});

test('密码不对：不写文件、页面给可重试的提示', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page, home }) => {
      const res = await post(page.url, { account: MOCK_API_ACCOUNT, secret: `${PASSWORD}-wrong`, mode: 'password' });
      assert.equal(res.status, 401);
      assert.match(res.text, /还能再试 2 次/);
      assert.equal(fs.existsSync(home.credFile), false, '失败不得留下凭据文件');
    });
  } finally {
    await mock.close();
  }
});

test('连续失败 3 次就停手，不留半截状态', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page, home }) => {
      for (let i = 0; i < 3; i++) {
        await post(page.url, { account: MOCK_API_ACCOUNT, secret: 'nope', mode: 'password' }).catch(() => {});
      }
      const state = await waitFor(() => {
        const st = readState(home.stateFile);
        return st && st.status === 'error' ? st : null;
      });
      assert.match(state.message, /连续 3 次/);
      assert.equal(fs.existsSync(home.credFile), false);
    });
  } finally {
    await mock.close();
  }
});

test('个人令牌：有效就写 ZENTAO_TOKEN，无效就不写', async () => {
  const state = createMockApiState();
  const mock = await startMockApi(state);
  try {
    // 先用账号密码换一个令牌（相当于用户在禅道「个人 → 令牌」看到的那种）
    const login = await fetch(`${mock.url}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: MOCK_API_ACCOUNT, password: PASSWORD }),
    });
    const { token } = await login.json();

    await withPage(mock, async ({ page, home }) => {
      const notAToken = ['not', 'a', 'token'].join('-');
      const bad = await post(page.url, { account: MOCK_API_ACCOUNT, secret: notAToken, mode: 'token' });
      assert.equal(bad.status, 401);
      assert.equal(fs.existsSync(home.credFile), false, '无效令牌不得写入');

      const good = await post(page.url, { account: MOCK_API_ACCOUNT, secret: token, mode: 'token' });
      assert.equal(good.status, 200, good.text);
      const raw = fs.readFileSync(home.credFile, 'utf8');
      assert.match(raw, new RegExp(`ZENTAO_TOKEN=${token}`));
      assert.doesNotMatch(raw, /ZENTAO_PASSWORD=/, '用令牌时不该写密码');
    });
  } finally {
    await mock.close();
  }
});

test('凭据内容不打印、不进 stderr', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page, getStderr }) => {
      await post(page.url, { account: MOCK_API_ACCOUNT, secret: PASSWORD, mode: 'password' });
      assert.equal(getStderr().includes(PASSWORD), false, '脚本输出里不能出现密码');
    });
  } finally {
    await mock.close();
  }
});

test('别的网页替你提交：跨站请求被拒绝', async () => {
  const mock = await startMockApi(createMockApiState());
  try {
    await withPage(mock, async ({ page, home }) => {
      const byOrigin = await post(page.url, { account: MOCK_API_ACCOUNT, secret: PASSWORD, mode: 'password' }, { origin: 'https://evil.example' });
      assert.equal(byOrigin.status, 403);
      const byFetchSite = await post(page.url, { account: MOCK_API_ACCOUNT, secret: PASSWORD, mode: 'password' }, { 'sec-fetch-site': 'cross-site' });
      assert.equal(byFetchSite.status, 403);
      assert.equal(fs.existsSync(home.credFile), false);
    });
  } finally {
    await mock.close();
  }
});

test('wait 等到结果，stop 能收掉页面', async () => {
  const mock = await startMockApi(createMockApiState());
  const home = tempHome();
  const env = {
    ...process.env,
    HOME: home.dir,
    ZENTAO_CREDENTIALS_FILE: home.credFile,
    ZENTAO_WEB_URL: mock.url,
    RH_CONNECT_NO_OPEN: '1',
  };
  delete env.APPDATA;
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  try {
    const started = await run(['start', '--no-open']);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /http:\/\/127\.0\.0\.1:\d+\/k\/[a-f0-9]{32}/);

    const page = await waitFor(() => {
      const st = readState(home.stateFile);
      return st && st.status === 'waiting' ? st : null;
    });
    const waiting = await run(['wait', '--timeout', '1']);
    assert.equal(waiting.code, 2, '没人填时 wait 应该超时退出，而不是失败');

    await post(page.url, { account: MOCK_API_ACCOUNT, secret: PASSWORD, mode: 'password' });
    const done = await run(['wait', '--timeout', '10']);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /凭据已写入并验证通过/);

    const stopped = await run(['stop']);
    assert.equal(stopped.code, 0);
  } finally {
    await mock.close();
  }
});
