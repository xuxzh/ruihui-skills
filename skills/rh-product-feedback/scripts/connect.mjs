#!/usr/bin/env node
// 本机写入页（rh-product-feedback 随包脚本）：让终端用户在自己的浏览器里填禅道凭据，
// 不离开 Agent、不用开终端、不把密码贴进对话。
//
// 为什么有它：终端脚本要求用户离开对话去开终端；Agent 的命令环境没有可交互输入，
// 把密码交给 Agent 又会进聊天记录。这个脚本只监听 127.0.0.1 上一个带一次性密钥的地址，
// 页面收下凭据后当场验证、直接写进本机凭据文件（0600），写完自己关掉。
//
// 用法：
//   node connect.mjs            # 起页面（后台驻留），打印本机地址
//   node connect.mjs wait       # 等页面填完，打印写入结果（默认最多等 300 秒）
//   node connect.mjs status     # 看当前状态
//   node connect.mjs stop       # 关掉页面
//   node connect.mjs serve      # 前台运行（调试与测试用）
//
// 边界：
//   - 只监听回环地址（127.0.0.1），地址里带一次性密钥；写完或超时即退出。
//   - 页面上收到的账号、密码、令牌只用于「验证 + 写文件」，不打印、不落日志、不进对话。
//   - 连续 3 次登录失败即停手：连续失败可能触发禅道锁号，比让人反复试更重要。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(PKG_DIR, 'config.local.json');

const DEFAULT_PAGE_TTL_SEC = 900; // 页面最多开 15 分钟
const DEFAULT_WAIT_SEC = 300; // wait 默认最多等 5 分钟（宿主命令超时可以调）
const MAX_ATTEMPTS = 3; // 连续登录失败上限，超过就停手
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SECRET_LEN = 512;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}
function fail(line) {
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------- 路径与配置

/** 本机接入凭据文件路径（与 entry 脚本一致，测试可用 ZENTAO_CREDENTIALS_FILE 覆盖）。 */
function credentialsPath(env = process.env) {
  if (env.ZENTAO_CREDENTIALS_FILE) return env.ZENTAO_CREDENTIALS_FILE;
  const base = process.platform === 'win32'
    ? (env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), '.config');
  return path.join(base, 'rh-zentao', 'credentials');
}

/** 页面状态文件：和凭据文件放同一个目录，只有本人可读。 */
function statePath(env = process.env) {
  return path.join(path.dirname(credentialsPath(env)), 'connect.json');
}

function resolveSite(env = process.env) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cfg = {};
  }
  return String(env.ZENTAO_WEB_URL || cfg?.zentaoWebUrl || '').replace(/\/+$/, '');
}

function readCredLines(env = process.env) {
  const file = credentialsPath(env);
  if (!fs.existsSync(file)) return {};
  const creds = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) creds[key] = value;
  }
  return creds;
}

// ---------------------------------------------------------------- 小工具

function readState(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const state = JSON.parse(text);
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  const dir = path.dirname(file);
  const mode = 0o700;
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function term(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** 页面里显示路径时把家目录缩成 ~，少一行折行。 */
function displayPath(file) {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/** 值会被写成 KEY=value 的一行：去掉首尾空白，拒绝换行/控制字符与超长输入。 */
function cleanValue(raw, { max = MAX_SECRET_LEN } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return { error: '不能为空' };
  if (value.length > max) return { error: '太长了' };
  if (/[\x00-\x1f\x7f]/.test(value)) return { error: '不能包含换行或控制字符' };
  return { value };
}

// ---------------------------------------------------------------- 写凭据

function writeCredentials(env, account, key, secret) {
  const file = credentialsPath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `ZENTAO_ACCOUNT=${account}\n${key}=${secret}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------- 验证

/** 账号密码换一次令牌：证明这组凭据是对的，顺手拿到本次的令牌。 */
async function checkPassword(site, account, password) {
  let res;
  try {
    res = await fetch(`${site}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
  } catch (err) {
    return { ok: false, kind: 'network', message: `连不上禅道：${err?.message || err}` };
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.token) return { ok: true, token: String(body.token) };
    return { ok: false, kind: 'network', message: `禅道没有返回令牌（HTTP ${res.status}）` };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, kind: 'auth', message: '禅道拒绝了这组账号密码（账号或密码不对，或账号被锁定）' };
  }
  return { ok: false, kind: 'network', message: `换令牌失败（HTTP ${res.status}）` };
}

/** 只读自检：读一次产品列表，拿到当前账号可见的产品（也是后续选品范围）。
 * 只发这一个 GET，认证头与入口脚本一致（Token）；不建单、不写任何数据。 */
async function readProducts(site, token) {
  let res;
  try {
    res = await fetch(`${site}/api.php/v2/products?pageID=1&recPerPage=100`, {
      headers: { Token: token },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { ok: false, detail: `连不上禅道：${err?.message || err}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: '令牌没能读到产品列表（令牌无效或没有权限）' };
  }
  if (!res.ok) return { ok: false, detail: `读产品列表失败（HTTP ${res.status}）` };
  const body = await res.json().catch(() => null);
  if (body?.status === 'fail') return { ok: false, detail: String(body.message || '禅道返回失败') };
  const list = Array.isArray(body?.products) ? body.products : Array.isArray(body?.data) ? body.data : [];
  const rows = list.map((row) => ({ id: String(row?.id ?? '').trim(), name: String(row?.name ?? '').trim() })).filter((row) => row.id);
  return { ok: true, count: rows.length, rows };
}

// ---------------------------------------------------------------- 页面

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c1f23}
main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px 28px 24px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
h1{font-size:19px;margin:0 0 6px}
p.sub{color:#5b636d;font-size:13px;margin:0 0 18px}
label{display:block;margin:0 0 14px;font-size:13px;color:#3d444d}
input[type=text],input[type=password]{display:block;width:100%;margin-top:6px;padding:10px 12px;font-size:15px;border:1px solid #ccd2d9;border-radius:8px;background:#fff;color:inherit}
input[type=text]:focus,input[type=password]:focus{outline:2px solid #4a7dff;outline-offset:-1px;border-color:#4a7dff}
.modes{display:flex;flex-direction:column;gap:6px;margin:0 0 16px;font-size:13px;color:#3d444d}
.modes label{display:flex;align-items:center;gap:8px;margin:0}
button{width:100%;padding:11px 14px;font-size:15px;font-weight:600;border:0;border-radius:8px;background:#2f6bff;color:#fff;cursor:pointer}
button:hover{background:#2559d8}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f1f3f6;padding:1px 5px;border-radius:4px;word-break:break-all}
.err{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fff1f0;border:1px solid #ffc9c4;color:#a4262c;font-size:13px}
.warn{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fff8e6;border:1px solid #ffe1a8;color:#7a4d00;font-size:13px}
.ok{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#eefbf1;border:1px solid #b8e6c4;color:#1a6b31;font-size:13px}
ul{margin:8px 0 18px;padding-left:18px;font-size:13px;color:#3d444d}
li{margin:2px 0}
dl{margin:0 0 18px;font-size:13px}
dt{color:#5b636d}
dd{margin:2px 0 10px;font-weight:600}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function renderForm(ctx, { error = '', account = '', mode = 'password' } = {}) {
  const secretLabel = '密码或个人令牌';
  return page(
    '接入禅道：写入本机凭据',
    `<h1>写入禅道账号凭据</h1>
<p class="sub">这个页面只跑在你这台电脑上（<code>127.0.0.1</code>），不改任何禅道数据。填完会连一次 <code>${escapeHtml(ctx.siteHost)}</code> 验证，验证通过才写入本机文件 <code>${escapeHtml(displayPath(ctx.credFile))}</code>；密码不会经过 AI 对话，也不会进命令行历史。</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(ctx.action)}">
  <label>禅道账号
    <input type="text" name="account" value="${escapeHtml(account)}" autocomplete="username" spellcheck="false" required autofocus>
  </label>
  <label>${secretLabel}
    <input type="password" name="secret" autocomplete="current-password" required>
  </label>
  <div class="modes">
    <label><input type="radio" name="mode" value="password"${mode === 'password' ? ' checked' : ''}>账号密码（推荐：下次也能用）</label>
    <label><input type="radio" name="mode" value="token"${mode === 'token' ? ' checked' : ''}>个人令牌（禅道「个人 → 令牌」生成，可单独撤销）</label>
  </div>
  <button type="submit">验证并写入</button>
</form>
<p class="sub">连续 3 次登录失败会自动停手，免得触发禅道锁号。写好后这个页面自己关掉，回到 Agent 继续说一句「验证一下禅道连接」就行。</p>`,
  );
}

function renderDone(ctx, { account, mode, count, rows }) {
  const list = rows.slice(0, 20).map((row) => `<li>${escapeHtml(row.id)}　${escapeHtml(row.name)}</li>`).join('');
  return page(
    '已写入禅道凭据',
    `<h1>凭据已写入并验证通过</h1>
<p class="ok">账号 <strong>${escapeHtml(account)}</strong>，方式「${mode === 'token' ? '个人令牌' : '账号密码'}」，已写进 <code>${escapeHtml(displayPath(ctx.credFile))}</code>（只有本人可读）。</p>
<dl><dt>当前账号可见的产品（也是你能提交的范围）</dt><dd>${count} 个</dd></dl>${count ? `<ul>${list}</ul>` : '<p class="warn">这个账号暂时读不到任何产品；让 Agent 跑一次自检，它会把原因说清楚（多半是禅道权限没开）。</p>'}
<p class="sub">这个页面已经关闭，可以关掉标签页回到 Agent 继续。</p>`,
  );
}

// ---------------------------------------------------------------- 服务

function send(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function openBrowser(url) {
  if (process.env.RH_CONNECT_NO_OPEN) return;
  const tries = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [['xdg-open', [url]]];
  for (const [cmd, args] of tries) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      return;
    } catch {}
  }
}

function cmdServe(env, opts) {
  const site = resolveSite(env);
  const file = statePath(env);
  const credFile = credentialsPath(env);
  const ttlSec = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_PAGE_TTL_SEC;

  if (!site) {
    const message =
      '技能包里没有配置禅道站点地址（config.local.json 的 zentaoWebUrl），不知道要连哪台禅道，页面没法起。找管理员核对接入配置。';
    writeState(file, { status: 'error', message, pid: process.pid, at: Date.now() });
    fail(`✗ ${message}`);
    return 1;
  }

  const siteHost = (() => {
    try {
      return new URL(site).host;
    } catch {
      return site;
    }
  })();

  const key = crypto.randomBytes(16).toString('hex');
  let attempts = 0;
  let finished = false;
  let timer = null;

  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '');
    const port = server.address()?.port;
    const hostOk = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (!hostOk) {
      return send(res, 403, page('地址不对', '<h1>403</h1><p class="sub">这个页面只接受来自本机的请求。</p>'));
    }

    const url = new URL(req.url, `http://${host}`);
    const match = url.pathname.match(/^\/k\/([a-f0-9]{32})\/?$/);
    const action = `/k/${key}`;
    const ctx = { siteHost, credFile, action };

    if (!match || match[1] !== key) {
      return send(res, 404, page('页面不存在', '<h1>404</h1><p class="sub">这个地址已经失效（页面是一次性的）。回到 Agent 让它重新打开一个写入页面。</p>'));
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const previous = readCredLines(env);
      return send(res, 200, renderForm(ctx, { account: previous.ZENTAO_ACCOUNT || '', mode: previous.ZENTAO_TOKEN ? 'token' : 'password' }));
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' });
      return res.end();
    }

    // 表单只能从本机页面提交：有 Origin 就必须是回环地址（挡掉别的网页跨站提交）。
    // 跨站提交挡在这里：浏览器会带 Sec-Fetch-Site，别的网页（或被改写的 Origin）一律不收。
    // 一次性密钥才是真正的门槛，这两道只是把「别人的页面替你提交」这条路堵死。
    const origin = String(req.headers.origin || '');
    const fetchSite = String(req.headers['sec-fetch-site'] || '');
    const originOk = !origin || origin === 'null' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    if (fetchSite === 'cross-site' || fetchSite === 'same-site' || !originOk) {
      return send(res, 403, page('来源不对', '<h1>403</h1><p class="sub">只接受来自本机页面的提交。</p>'));
    }

    let form;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch (err) {
      return send(res, 400, renderForm(ctx, { error: `提交没读全：${err.message}` }));
    }

    const account = cleanValue(form.get('account'), { max: 64 });
    const secret = cleanValue(form.get('secret'));
    const mode = form.get('mode') === 'token' ? 'token' : 'password';
    if (account.error || secret.error) {
      return send(
        res,
        400,
        renderForm(ctx, {
          error: `账号或密码不合法（${account.error || secret.error}）`,
          account: String(form.get('account') || ''),
          mode,
        }),
      );
    }

    let token = secret.value;
    if (mode === 'password') {
      const checked = await checkPassword(site, account.value, secret.value);
      if (checked.ok) token = checked.token;
      if (!checked.ok) {
        if (checked.kind === 'network') {
          return send(res, 502, renderForm(ctx, { error: checked.message, account: account.value, mode }));
        }
        attempts++;
        const left = MAX_ATTEMPTS - attempts;
        if (left <= 0) return tooMany(res);
        return send(
          res,
          401,
          renderForm(ctx, {
            error: `${checked.message}。还能再试 ${left} 次；也可以换成「个人令牌」。`,
            account: account.value,
            mode,
          }),
        );
      }
    }

    // 先自检再落盘：凭据一旦写下去就会被后面的会话当成「已接好」，写错的代价比多问一次大。
    const check = await readProducts(site, token);
    if (!check.ok) {
      attempts++;
      if (attempts >= MAX_ATTEMPTS) return tooMany(res);
      return send(
        res,
        mode === 'token' ? 401 : 502,
        renderForm(ctx, {
          error: `${check.detail}。没有写入；还能再试 ${MAX_ATTEMPTS - attempts} 次。`,
          account: account.value,
          mode,
        }),
      );
    }

    const keyName = mode === 'token' ? 'ZENTAO_TOKEN' : 'ZENTAO_PASSWORD';
    try {
      writeCredentials(env, account.value, keyName, secret.value);
    } catch (err) {
      return send(res, 500, page('写不进去', `<h1>凭据没写成</h1><p class="err">${escapeHtml(err.message)}</p><p class="sub">检查一下 <code>${escapeHtml(displayPath(credFile))}</code> 所在目录的权限。</p>`));
    }

    const products = check.rows;
    writeState(file, {
      status: 'done',
      account: account.value,
      mode,
      productCount: check.count,
      products,
      at: Date.now(),
    });
    send(res, 200, renderDone(ctx, { account: account.value, mode, count: check.count, rows: products }));
    finish(0);
  });

  function finish(code) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    server.close(() => {});
    setTimeout(() => process.exit(code), 400);
  }

  // 连续失败就停手：宁可让用户重开一次页面，也别把钱道账号试到锁。
  function tooMany(res) {
    const message = `连续 ${MAX_ATTEMPTS} 次失败，已经停手（免得触发禅道锁号）。确认账号密码后回到 Agent 重新打开写入页面。`;
    writeState(file, { status: 'error', message, pid: process.pid, at: Date.now() });
    send(res, 401, page('已停手', `<h1>先停在这里</h1><p class="err">${escapeHtml(message)}</p>`));
    finish(1);
  }

  server.on('error', (err) => {
    const message = `本机页面起不来：${err.message}`;
    writeState(file, { status: 'error', message, pid: process.pid, at: Date.now() });
    fail(`✗ ${message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/k/${key}`;
    const expiresAt = Date.now() + ttlSec * 1000;
    writeState(file, { status: 'waiting', url, pid: process.pid, port, site: siteHost, startedAt: Date.now(), expiresAt });
    out('# 本机写入页面已就绪（只监听 127.0.0.1，用完即关）');
    out(`地址：${url}`);
    out(`有效期：${Math.round(ttlSec / 60)} 分钟`);
    out('让终端用户在这台机器的浏览器里打开它，填禅道账号和密码；页面会自己验证并写入凭据。');
    out('打不开这个地址（远程 SSH、容器里跑）就让终端用户跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Windows 用 set-credentials.ps1）。');
    if (!opts['no-open']) openBrowser(url);
    timer = setTimeout(() => {
      writeState(file, { status: 'expired', message: '页面超过有效期，没人填', pid: process.pid, at: Date.now() });
      out('# 页面过期，已关闭');
      finish(2);
    }, ttlSec * 1000);
    timer.unref?.();
  });

  return null; // 由 finish/exit 结束进程
}

// ---------------------------------------------------------------- 命令

function cmdStart(env, opts) {
  const file = statePath(env);
  const existing = readState(file);
  if (existing && existing.status === 'waiting' && Number(existing.expiresAt) > Date.now() && pidAlive(existing.pid)) {
    out('# 已经有一个写入页面在等（同一个地址，不用重复开）');
    out(`地址：${existing.url}`);
    out(`还剩：${Math.max(0, Math.round((existing.expiresAt - Date.now()) / 1000))} 秒`);
    return 0;
  }

  const args = [fileURLToPath(import.meta.url), 'serve'];
  if (opts['no-open']) args.push('--no-open');
  if (opts.timeout) args.push('--timeout', String(opts.timeout));
  let child;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: true });
    child.unref();
  } catch (err) {
    fail(`✗ 本机页面起不来：${err.message}`);
    return 1;
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = readState(file);
    if (state && state.pid === child.pid && state.status === 'waiting' && state.url) {
      out('# 本机写入页面已就绪（只监听 127.0.0.1，用完即关）');
      out(`地址：${state.url}`);
      out(`有效期：${Math.round((state.expiresAt - Date.now()) / 1000)} 秒`);
      out('让终端用户在这台机器的浏览器里打开它，填禅道账号和密码；页面会自己验证并写入凭据。');
      out('打不开这个地址（远程 SSH、容器里跑）就让终端用户跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Windows 用 set-credentials.ps1）。');
      out(`填完回来跑：node <技能目录>/scripts/connect.mjs wait`);
      return 0;
    }
    // 只看这一轮起的那个进程写下的状态：上一轮留下的 error 不该把这一次挡回去。
    if (state && state.status === 'error' && state.pid === child.pid) {
      fail(`✗ ${state.message || '本机页面起不来'}`);
      return 1;
    }
    sleepSync(100);
  }
  fail('✗ 本机页面没起来（8 秒内没拿到地址）。直接跑 `node connect.mjs serve` 看它报什么错。');
  return 1;
}

function printResult(state) {
  if (state.status === 'done') {
    out('# 凭据已写入并验证通过');
    out(`账号：${state.account}`);
    out(`方式：${state.mode === 'token' ? '个人令牌' : '账号密码'}`);
    out(`可见产品：${state.productCount} 个（这就是后续选品范围）`);
    for (const product of state.products || []) out(`${product.id}\t${product.name}`);
    return 0;
  }
  if (state.status === 'error') {
    fail(`✗ ${state.message || '写入失败'}`);
    return 1;
  }
  if (state.status === 'expired') {
    fail('✗ 页面超过有效期，没人填。需要重新跑一次 connect。');
    return 2;
  }
  return null;
}

function cmdWait(env, opts) {
  const file = statePath(env);
  const limitSec = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_WAIT_SEC;
  const deadline = Date.now() + limitSec * 1000;

  for (;;) {
    const state = readState(file);
    if (!state) {
      fail('✗ 没有正在等待的写入页面。先跑 `node connect.mjs` 起页面，再把地址给终端用户。');
      return 3;
    }
    const code = printResult(state);
    if (code !== null) return code;
    if (!pidAlive(state.pid)) {
      fail('✗ 页面进程已经不在了（可能被关掉或宿主回收）。重新跑一次 `node connect.mjs`。');
      return 3;
    }
    if (Date.now() >= deadline) {
      const left = Math.max(0, Math.round((Number(state.expiresAt) - Date.now()) / 1000));
      fail(`# 还在等终端用户在页面上填（页面还剩 ${left} 秒）`);
      fail(`地址：${state.url}`);
      fail('如果它已经填完了，再跑一次 wait 就能拿到结果；不想等了就跑 `node connect.mjs stop`。');
      return 2;
    }
    sleepSync(500);
  }
}

function cmdStatus(env) {
  const state = readState(statePath(env));
  if (!state) {
    out('# 没有写入页面的记录');
    return 0;
  }
  out(`# 状态：${state.status}`);
  if (state.url) out(`地址：${state.url}`);
  if (state.status === 'waiting') out(`进程：${state.pid}（${pidAlive(state.pid) ? '在跑' : '已退出'}）`);
  const code = printResult(state);
  return code === null ? 0 : code;
}

function cmdStop(env) {
  const file = statePath(env);
  const state = readState(file);
  if (!state || !state.pid || !pidAlive(state.pid)) {
    out('# 没有在跑的写入页面');
    return 0;
  }
  term(state.pid);
  writeState(file, { status: 'expired', message: '被主动关掉', at: Date.now() });
  out('# 已关掉写入页面');
  return 0;
}

// ---------------------------------------------------------------- 入口

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const cmd = first && !first.startsWith('--') ? first : 'start';
  const args = cmd === 'start' && first !== 'start' ? argv : rest;
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[arg.slice(2)] = next;
      i++;
    } else {
      opts[arg.slice(2)] = true;
    }
  }
  return { cmd, opts };
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const env = process.env;

  switch (cmd) {
    case 'start':
      return cmdStart(env, opts);
    case 'serve': {
      const code = cmdServe(env, opts);
      return code ?? null; // null = 服务在跑，由 finish 结束
    }
    case 'wait':
      return cmdWait(env, opts);
    case 'status':
      return cmdStatus(env);
    case 'stop':
      return cmdStop(env);
    case 'help':
    case '--help':
    case '-h':
      out(`用法：
  node connect.mjs                起本机写入页面（后台驻留），打印地址
  node connect.mjs wait           等页面填完，打印写入结果
  node connect.mjs status         看当前状态
  node connect.mjs stop           关掉页面
  node connect.mjs serve          前台运行（调试/测试用）
选项：
  --timeout <秒>    页面有效期（serve，默认 ${DEFAULT_PAGE_TTL_SEC}）/ wait 的等待上限（默认 ${DEFAULT_WAIT_SEC}）
  --no-open         不自动打开浏览器`);
      return 0;
    default:
      fail(`未知子命令：${cmd}（可用：start / wait / status / stop / serve / help）`);
      return 2;
  }
}

const code = main();
if (typeof code === 'number') process.exit(code);
