#!/usr/bin/env node
// 禅道接入的公共部分：读本机凭据、换用户令牌、带令牌的 MCP 客户端。
//
// 为什么不能只用宿主里的禅道 MCP 工具：实测该服务端的 post_users_login 不校验传入凭据，
// 恒以服务端配置的固定身份对外服务，所有经它提交的单据都留痕在那个账号名下。服务端同时接受调用方自带的禅道令牌：请求头带上 Authorization: Bearer <用户令牌>
// 时，它就用这个令牌的身份去调禅道——无效令牌直接 401。
//
// 因此这里的分工是：
//   - 认证：用本机凭据直连禅道换一个「用户自己的」令牌（密码换令牌，或直接用禅道里生成的个人令牌）
//   - 传输：带 Authorization 头访问禅道 MCP，令牌不进 Agent 上下文、不打印
//   - 身份：单据留痕在换到令牌的个禅道账号名下

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(PKG_DIR, 'config.local.json');

/** 技能包配置（地址与默认产品都在这里，不回显）。 */
export function loadPackageConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    throw new Error(`读不到技能包配置：${path.basename(CONFIG_PATH)}`);
  }
}

/** 本机接入凭据文件路径。 */
export function credentialsPath(env = process.env) {
  if (env.ZENTAO_CREDENTIALS_FILE) return env.ZENTAO_CREDENTIALS_FILE;
  if (process.platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'rh-zentao', 'credentials');
  }
  return path.join(os.homedir(), '.config', 'rh-zentao', 'credentials');
}

/** 读本机凭据；没有文件时返回空对象（调用方给可执行指引，不要索要密码）。 */
export function loadCredentials(env = process.env) {
  const file = credentialsPath(env);
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/** 禅道 Web 根地址：环境变量优先，其次技能包 config.local.json。 */
export function resolveWebUrl(cfg, env = process.env) {
  const raw = env.ZENTAO_WEB_URL || cfg?.zentaoWebUrl || '';
  return String(raw).replace(/\/+$/, '');
}

/** 禅道 MCP 地址：环境变量优先，其次技能包 config.local.json。 */
export function resolveMcpUrl(cfg, env = process.env) {
  const raw = env.ZENTAO_MCP_URL || cfg?.mcpUrl || '';
  return String(raw).replace(/\/+$/, '');
}

/**
 * 换当前用户的禅道令牌。
 * 返回 { token, account, source }；失败时抛错，错误信息要能指导用户下一步，但不回显凭据。
 */
export async function resolveUserToken(creds, cfg, env = process.env) {
  const account = String(creds.ZENTAO_ACCOUNT || '').trim();
  const personalToken = String(creds.ZENTAO_TOKEN || '').trim();
  const password = String(creds.ZENTAO_PASSWORD || '').trim();

  // 禅道界面「个人 → 令牌」生成的令牌本身就是用户身份，直接用。
  if (personalToken) return { token: personalToken, account, source: '个人令牌' };

  if (!account || !password) {
    throw new Error(
      '本机没有禅道接入凭据。在你自己的终端跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Windows 用 set-credentials.ps1）' +
        '写入账号与密码；不要在对话里把密码告诉 Agent。'
    );
  }

  const webUrl = resolveWebUrl(cfg, env);
  if (!webUrl) {
    throw new Error('技能包里没有配置禅道 Web 地址（config.local.json 的 zentaoWebUrl），换不到用户令牌。');
  }

  let res;
  try {
    res = await fetch(`${webUrl}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
  } catch (err) {
    throw new Error(`连不上禅道（换令牌失败）：${err?.message || err}`);
  }

  if (res.status === 201 || (res.ok && res.status === 200)) {
    const body = await res.json().catch(() => null);
    if (body?.token) return { token: String(body.token), account, source: '账号密码' };
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error(
      '禅道拒绝了本机凭据（账号或密码不对，或账号被锁定）。请在本机重写接入凭据后重试；' +
        '连续失败可能触发禅道锁号，不要反复试。'
    );
  }
  throw new Error(`换禅道令牌失败（HTTP ${res.status}）。`);
}

/** 禅道 MCP 的 Streamable HTTP 客户端：带 Authorization 头，令牌只留在进程内。 */
export class McpClient {
  constructor(url, { token = '', timeoutMs = 30000 } = {}) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.seq = 0;
  }

  async post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      // 服务端拿这个头去认证禅道：带用户令牌就是用户身份，不带就是服务端配置的那个固定身份。
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const raw = await res.text();
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      let payload = null;
      if (dataLines.length) {
        try { payload = JSON.parse(dataLines.join('')); } catch { payload = null; }
      } else if (raw.trim()) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
      return { httpStatus: res.status, payload };
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('禅道 MCP 请求超时');
      throw new Error(`连不上禅道 MCP：${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async rpc(method, params) {
    const res = await this.post({ jsonrpc: '2.0', id: ++this.seq, method, params });
    const payload = res.payload;
    if (!payload) throw new Error(`禅道 MCP 响应无法解析（HTTP ${res.httpStatus}）`);
    if (payload.error) {
      throw new Error(`禅道 MCP 报错：${payload.error.code} ${payload.error.message || ''}`.trim());
    }
    return payload.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rh-zentao', version: '1.0.0' },
    });
    await this.notify('notifications/initialized', {});
  }

  /** 调一个工具；返回 { statusLine, body, raw }，body 是服务端正文里的 JSON 对象。 */
  async call(tool, args) {
    const result = await this.rpc('tools/call', { name: tool, arguments: args });
    const content = result?.content || [];
    const text = content.map((c) => c.text ?? '').join('\n');
    const statusLine = (content[0]?.text || '').trim();
    const brace = text.indexOf('{');
    let body = null;
    if (brace >= 0) {
      try { body = JSON.parse(text.slice(brace)); } catch { body = null; }
    }
    return { statusLine, body, raw: text };
  }
}

/**
 * 连上禅道：换用户令牌 → 带令牌建 MCP 会话。
 * 返回 { client, account, source }；account 是当前登录的禅道账号名。
 */
export async function connectAsUser(env = process.env) {
  const cfg = loadPackageConfig();
  const mcpUrl = resolveMcpUrl(cfg, env);
  if (!mcpUrl) throw new Error('技能包里没有配置禅道 MCP 地址');
  const creds = loadCredentials(env);
  const { token, account, source } = await resolveUserToken(creds, cfg, env);
  const client = new McpClient(mcpUrl, { token });
  await client.initialize();
  return { client, account, source, cfg };
}
