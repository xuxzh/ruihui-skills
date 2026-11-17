// 极简 MCP Streamable HTTP 客户端 + .env 读取。
// 供 tests/e2e-mock.mjs（mock）与 tests/e2e-live.mjs（真实禅道）共用。
// 凭据只从环境变量 / .env 读，不打印、不写进仓库。
import fs from 'node:fs';

export function loadEnv(file = '.env') {
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

export class McpClient {
  constructor(url, { headers = {}, timeoutMs = 15000 } = {}) {
    this.url = url;
    this.headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.seq = 0;
  }

  async post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { ...this.headers, ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const raw = await res.text();
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      let payload = null;
      if (dataLines.length) {
        try { payload = JSON.parse(dataLines.join('')); } catch { payload = { raw }; }
      } else if (raw.trim()) {
        try { payload = JSON.parse(raw); } catch { payload = { raw }; }
      }
      return { httpStatus: res.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize() {
    const res = await this.post({
      jsonrpc: '2.0', id: ++this.seq, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rh-product-feedback-test', version: '0.1.0' } },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return res;
  }

  async toolsList() {
    const res = await this.post({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/list', params: {} });
    return res.payload?.result?.tools || [];
  }

  // 返回 { httpStatus, text, data, status, timedOut }
  async callTool(name, args = {}) {
    let res;
    try {
      res = await this.post({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } });
    } catch (err) {
      if (err?.name === 'AbortError') return { httpStatus: 0, text: '', data: null, status: null, timedOut: true };
      throw err;
    }
    if (res.httpStatus === 401) return { httpStatus: 401, text: '', data: null, status: null, unauthorized: true };

    const rpcError = res.payload?.error || null;
    const content = res.payload?.result?.content || [];
    const text = content.map((c) => c.text ?? c.data ?? '').join('\n');
    let data = res.payload?.result?.structuredContent ?? null;
    if (!data || typeof data !== 'object') {
      const brace = text.indexOf('{');
      if (brace >= 0) {
        try { data = JSON.parse(text.slice(brace)); } catch { data = null; }
      }
    }
    return {
      httpStatus: res.httpStatus,
      text,
      data,
      status: data?.status ?? null,
      isError: !!res.payload?.result?.isError || !!rpcError,
      error: rpcError,
    };
  }
}
