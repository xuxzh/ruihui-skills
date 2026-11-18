#!/usr/bin/env node
// 上传图片到禅道，返回文件 ID 与正文里要用的图片引用。
//
// 用法：
//   node zentao-upload.mjs --file <图片路径> --object-type <feedback|bug> --object-id <单据 ID> [--name <文件名>] [--remove]
//   node zentao-upload.mjs --base64 <base64 串或 -> --object-type <feedback|bug> --object-id <单据 ID> [--ext png]
//
// 为什么不用 MCP 的 post_files：那个工具的 payload 只有 fileName，没有内容字段，
// 禅道会回「文件上传失败，文件格式不在规定范围内」（见 references/zentao-mcp.md）。
// 真正能传内容的是禅道 REST v2 的 POST /api.php/v2/files（multipart）。
//
// 三条硬约束：
//   1. v2 上传必须带 objectType 与 objectID：图片只能挂在**已经存在**的单据上，
//      所以顺序永远是「先建单 → 再传图 → 再更新正文」。
//   2. 凭据读本机接入凭据文件，地址读技能包 config.local.json；令牌只在进程内使用，不打印。
//   3. 上传后回读字节与禅道文件元数据确认真的写进去了，不拿「保存成功」文案当证据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(SKILL_DIR, 'config.local.json');
const UPLOAD_PATH = '/api.php/v2/files';
const MAX_BYTES = 10 * 1024 * 1024;

const HELP = `禅道图片上传（rh-product-feedback）
  --file <路径>            本地图片文件
  --base64 <base64 串|->   图片字节；- 表示从标准输入读
  --object-type <类型>     feedback | bug（图片要挂在这类单据上）
  --object-id <ID>         单据 ID
  --name <文件名>          上传时用的文件名（默认取本地文件名）
  --ext <扩展名>           base64 模式的扩展名（默认 png）
  --max-bytes <字节>       本地大小上限（默认 10 MiB）
  --remove                 上传成功后删掉本地临时文件
环境变量：ZENTAO_BASE_URL 覆盖禅道地址；ZENTAO_MCP_URL 覆盖 MCP 地址；ZENTAO_CREDENTIALS_FILE 覆盖凭据文件`;

// ---------------------------------------------------------------- 输出
function out(line = '') {
  process.stdout.write(`${line}\n`);
}
function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const opts = { maxBytes: MAX_BYTES };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`参数 ${key} 缺值`);
      return value;
    };
    switch (key) {
      case '--file': opts.file = next(); break;
      case '--base64': opts.base64 = next(); break;
      case '--object-type': opts.objectType = next(); break;
      case '--object-id': opts.objectId = next(); break;
      case '--name': opts.name = next(); break;
      case '--ext': opts.ext = next(); break;
      case '--max-bytes': opts.maxBytes = Number(next()); break;
      case '--remove': opts.remove = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: fail(`未知参数：${key}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 接入配置与凭据
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    fail(`读不到技能包配置：${path.basename(CONFIG_PATH)}`);
  }
}
function credentialsPath() {
  if (process.env.ZENTAO_CREDENTIALS_FILE) return process.env.ZENTAO_CREDENTIALS_FILE;
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'rh-zentao', 'credentials');
  }
  return path.join(os.homedir(), '.config', 'rh-zentao', 'credentials');
}
function loadCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/, '');
    if (key) values[key] = value;
  }
  return values;
}

// ---------------------------------------------------------------- 极简 MCP 客户端（只用来换令牌）
class McpClient {
  constructor(url, timeoutMs = 30000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.seq = 0;
  }
  async post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const raw = await res.text();
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      if (dataLines.length) return JSON.parse(dataLines.join(''));
      if (raw.trim()) return JSON.parse(raw);
      return null;
    } catch (err) {
      if (err?.name === 'AbortError') fail('禅道 MCP 请求超时');
      fail(`连不上禅道 MCP：${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
  }
  async rpc(method, params) {
    const payload = await this.post({ jsonrpc: '2.0', id: ++this.seq, method, params });
    if (!payload) fail('禅道 MCP 响应无法解析');
    if (payload.error) fail(`禅道 MCP 报错：${payload.error.code} ${payload.error.message || ''}`.trim());
    return payload.result;
  }
  async callTool(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = (result?.content || []).map((c) => c.text ?? '').join('\n');
    const brace = text.indexOf('{');
    if (brace < 0) return null;
    try {
      return JSON.parse(text.slice(brace));
    } catch {
      return null;
    }
  }
  async initialize() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rh-zentao-upload', version: '1.0.0' },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }
}

/** 用禅道 MCP 登录换令牌；拿不到就返回 null（调用方再走直连登录）。 */
async function tokenViaMcp(mcpUrl, credentials) {
  const client = new McpClient(mcpUrl);
  try {
    await client.initialize();
    const body = await client.callTool('post_users_login', {
      payload: { account: credentials.ZENTAO_ACCOUNT, password: credentials.ZENTAO_PASSWORD || credentials.ZENTAO_TOKEN || '' },
    });
    if (body?.status && body.status !== 'success') return null;
    return body?.token || null;
  } catch {
    return null;
  }
}

/** 直连禅道换取令牌（官方 v1 认证接口）；失败返回 null。 */
async function tokenViaApi(baseUrl, credentials) {
  try {
    const res = await fetch(`${baseUrl}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: credentials.ZENTAO_ACCOUNT, password: credentials.ZENTAO_PASSWORD || '' }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.token || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 图片字节
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function loadImage(opts) {
  if (opts.file) {
    const file = path.resolve(opts.file);
    if (!fs.existsSync(file)) fail(`找不到图片文件：${file}`);
    const bytes = fs.readFileSync(file);
    const name = opts.name || path.basename(file);
    return { bytes, name, ext: extensionOf(name), source: file };
  }
  if (opts.base64) {
    const raw = opts.base64 === '-' ? (await readStdin()).toString('utf8') : opts.base64;
    let bytes;
    try {
      bytes = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    } catch {
      fail('base64 解不开');
    }
    if (!bytes.length) fail('base64 解出来是空的');
    const ext = (opts.ext || 'png').replace(/^\./, '').toLowerCase();
    const name = opts.name || `image.${ext}`;
    return { bytes, name, ext: extensionOf(name), source: null };
  }
  fail('要给 --file 或 --base64 其中一个');
}
function extensionOf(name) {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ext || 'png';
}

// ---------------------------------------------------------------- 上传与回读
async function uploadFile(baseUrl, token, { bytes, name, objectType, objectID }) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  form.append('objectType', objectType);
  form.append('objectID', String(objectID));
  const res = await fetch(`${baseUrl}${UPLOAD_PATH}`, { method: 'POST', headers: { Token: token }, body: form });
  const text = await res.text();
  let body = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { httpStatus: res.status, body, raw: text };
}

async function readFileBytes(baseUrl, token, fileId) {
  const res = await fetch(`${baseUrl}/api.php/v1/files/${fileId}`, { headers: { Token: token } });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.length ? buffer : null;
}

async function readFileMeta(baseUrl, token, fileId) {
  try {
    const res = await fetch(`${baseUrl}${UPLOAD_PATH}/${fileId}`, { headers: { Token: token } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.file || null;
  } catch {
    return null;
  }
}

/** 正文里用的图片引用：相对路径 + 文件 ID。 */
function buildReference(fileId, ext) {
  return `<img src="/index.php?m=file&f=read&t=${ext}&fileID=${fileId}" alt="file-read-${fileId}.${ext}" />`;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    out(HELP);
    return;
  }
  if (!opts.objectType || !['feedback', 'bug'].includes(opts.objectType)) {
    fail('--object-type 只能是 feedback 或 bug');
  }
  if (!opts.objectId || !/^\d+$/.test(String(opts.objectId))) {
    fail('--object-id 必须是单据的数字 ID');
  }

  const config = loadConfig();
  const baseUrl = (process.env.ZENTAO_BASE_URL || config.zentaoWebUrl || '').replace(/\/+$/, '');
  if (!baseUrl) fail('技能包里没有配置禅道 Web 地址，无法上传图片');
  const mcpUrl = process.env.ZENTAO_MCP_URL || config.mcpUrl;
  if (!mcpUrl) fail('技能包里没有配置禅道 MCP 地址，无法登录禅道');

  const credentials = loadCredentials();
  if (!credentials || !credentials.ZENTAO_ACCOUNT) {
    fail('本机没有禅道接入凭据。在你自己的终端跑一次 `bash <技能目录>/scripts/set-credentials.sh` 写入账号密码。');
  }

  const image = await loadImage(opts);
  if (image.bytes.length > opts.maxBytes) {
    fail(`图片 ${image.bytes.length} 字节，超过上限 ${opts.maxBytes} 字节；先压缩再上传`);
  }

  let token = mcpUrl ? await tokenViaMcp(mcpUrl, credentials) : null;
  if (!token) token = await tokenViaApi(baseUrl, credentials);
  if (!token) fail('拿不到禅道令牌：MCP 登录与直连登录都没成功');

  let result = await uploadFile(baseUrl, token, {
    bytes: image.bytes,
    name: image.name,
    objectType: opts.objectType,
    objectID: opts.objectId,
  });

  // MCP 的登录令牌可能对不上禅道接口：401 时换直连登录的令牌重试一次。
  if (result.httpStatus === 401) {
    const fresh = await tokenViaApi(baseUrl, credentials);
    if (fresh && fresh !== token) {
      token = fresh;
      result = await uploadFile(baseUrl, token, {
        bytes: image.bytes,
        name: image.name,
        objectType: opts.objectType,
        objectID: opts.objectId,
      });
    }
  }

  if (result.httpStatus === 401) fail('禅道拒绝了这次上传：令牌无效');
  if (result.httpStatus === 403) fail('禅道拒绝了这次上传：当前账号没有权限');
  if (result.httpStatus >= 400) {
    fail(`上传失败：HTTP ${result.httpStatus}${result.body?.message ? ` ${result.body.message}` : ''}`);
  }

  const body = result.body;
  if (!body) {
    fail('禅道没有返回可解析的结果（HTTP 200 但正文为空），按未成功处理；别重复上传，先查单据');
  }
  if (body.status && body.status !== 'success') {
    fail(`上传失败：${body.message || body.status}`);
  }

  const fileId = body.id ?? String(body.url || '').match(/fileID=(\d+)/)?.[1];
  if (!fileId) {
    fail(`上传返回里没有文件 ID（status=${body.status ?? '未知'}），没法生成图片引用；先查禅道里有没有多出附件`);
  }

  const stored = await readFileBytes(baseUrl, token, fileId);
  if (!stored) {
    fail(`上传返回成功，但回读文件 ${fileId} 读不到字节，按未成功处理`);
  }
  if (stored.length !== image.bytes.length) {
    fail(`上传返回成功，但字节数对不上（本地 ${image.bytes.length}，禅道 ${stored.length}），按未成功处理`);
  }

  const meta = await readFileMeta(baseUrl, token, fileId);
  const reference = buildReference(fileId, image.ext);
  out('# 上传成功');
  out(`文件 ID：${fileId}`);
  out(`图片引用：${reference}`);
  out(`字节核对：本地 ${image.bytes.length}，禅道 ${stored.length}，一致`);
  if (meta) {
    const sameObject = String(meta.objectID) === String(opts.objectId);
    out(`挂载对象：${meta.objectType || '未知'} #${meta.objectID || '未知'}${sameObject ? '' : '（与目标单据不一致）'}`);
  }
  if (opts.remove && image.source) {
    try {
      fs.unlinkSync(image.source);
      out('已删除本地临时文件');
    } catch {
      out('本地临时文件删除失败，请手动清理');
    }
  }
  out('把这行图片引用放进正文即可。');
}

main().catch((err) => {
  process.stderr.write(`错误：${err?.message || err}\n`);
  process.exit(1);
});
