// 图片上传脚本的测试：在 mock MCP + 本地假禅道上验证上传、引用生成、失败处理与凭据不外泄。
//
// 运行：node --test tests/upload.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-zentao-mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'rh-product-feedback', 'scripts', 'zentao-upload.mjs');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 本地假禅道：实现上传、文件字节回读、文件元数据、令牌接口。 */
function startFakeZentao({ mode = 'ok' } = {}) {
  const state = { uploads: [], tokenRequests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url || '';
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && url === '/api.php/v2/files') {
        state.uploads.push({ headers: req.headers, body });
        if (mode === 'reject') {
          json(200, { status: 'fail', message: '文件上传失败，文件格式不在规定范围内' });
          return;
        }
        json(200, { status: 'success', id: 4242, url: '/index.php?m=file&f=read&t=png&fileID=4242' });
        return;
      }
      if (req.method === 'GET' && /^\/api\.php\/v1\/files\//.test(url)) {
        if (mode === 'corrupt') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(PNG.subarray(0, 8));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(PNG);
        return;
      }
      if (req.method === 'GET' && /^\/api\.php\/v2\/files\//.test(url)) {
        json(200, {
          status: 'success',
          file: { id: '4242', title: 'image.png', extension: 'png', objectType: 'feedback', objectID: '65' },
        });
        return;
      }
      if (req.method === 'POST' && url === '/api.php/v1/tokens') {
        json(201, { token: '{{FAKE_TOKEN}}' });
        json(201, { token: 'direct-token-value' });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

/** 跑一次上传脚本，返回 { code, stdout, stderr }。用异步 spawn：mock 服务与假禅道都跑在本进程里。 */
function runUpload({ zentaoUrl, mcpUrl, credentialsFile, imagePath, args = [] }) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, '--file', imagePath, '--object-type', 'feedback', '--object-id', '65', ...args], {
      env: {
        ...process.env,
        ZENTAO_BASE_URL: zentaoUrl,
        ZENTAO_MCP_URL: mcpUrl,
        ZENTAO_CREDENTIALS_FILE: credentialsFile,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setup() {
  const dir = tempDir('rh-upload-test-');
  const credentialsFile = path.join(dir, 'credentials');
  fs.writeFileSync(credentialsFile, 'ZENTAO_ACCOUNT=tester\nZENTAO_PASSWORD=secret-pass\n');
  const imagePath = path.join(dir, 'shot.png');
  fs.writeFileSync(imagePath, PNG);
  return { dir, credentialsFile, imagePath };
}

test('上传成功：返回文件 ID 与图片引用，并核对字节', async () => {
  const { dir, credentialsFile, imagePath } = setup();
  const mock = await startMockServer();
  const zentao = await startFakeZentao();
  try {
    const run = await runUpload({ zentaoUrl: zentao.url, mcpUrl: mock.url, credentialsFile, imagePath });
    assert.equal(run.code, 0, `上传应成功：${run.stderr}`);
    assert.match(run.stdout, /文件 ID：4242/);
    assert.match(run.stdout, /<img src="\/index\.php\?m=file&f=read&t=png&fileID=4242"/);
    assert.match(run.stdout, /字节核对：本地 \d+，禅道 \d+，一致/);
    assert.match(run.stdout, /挂载对象：feedback #65/);

    // 上传请求确实带了内容与挂载对象
    assert.equal(zentao.state.uploads.length, 1);
    const upload = zentao.state.uploads[0];
    assert.match(String(upload.headers['content-type']), /multipart\/form-data/);
    const text = upload.body.toString('latin1');
    assert.match(text, /name="file"/);
    assert.match(text, /name="objectType"[\s\S]*feedback/);
    assert.match(text, /name="objectID"[\s\S]*65/);
  } finally {
    await mock.close();
    await zentao.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('凭据与令牌不进输出', async () => {
  const { dir, credentialsFile, imagePath } = setup();
  const mock = await startMockServer();
  const zentao = await startFakeZentao();
  try {
    const run = await runUpload({ zentaoUrl: zentao.url, mcpUrl: mock.url, credentialsFile, imagePath });
    assert.equal(run.code, 0);
    assert.ok(!run.stdout.includes('secret-pass'), '输出里不该出现密码');
    assert.ok(!run.stdout.includes('{{SECRET_mock}}'), '输出里不该出现令牌');
    assert.ok(!run.stderr.includes('secret-pass'), '输出里不该出现密码');
  } finally {
    await mock.close();
    await zentao.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('禅道拒绝上传：报错并带上服务端原因，不当成成功', async () => {
  const { dir, credentialsFile, imagePath } = setup();
  const mock = await startMockServer();
  const zentao = await startFakeZentao({ mode: 'reject' });
  try {
    const run = await runUpload({ zentaoUrl: zentao.url, mcpUrl: mock.url, credentialsFile, imagePath });
    assert.notEqual(run.code, 0, '被拒绝时必须非零退出');
    assert.match(run.stderr, /文件上传失败，文件格式不在规定范围内/);
    assert.ok(!run.stdout.includes('文件 ID'), '失败时不该给出文件 ID');
  } finally {
    await mock.close();
    await zentao.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上传后回读字节对不上：按未成功处理', async () => {
  const { dir, credentialsFile, imagePath } = setup();
  const mock = await startMockServer();
  const zentao = await startFakeZentao({ mode: 'corrupt' });
  try {
    const run = await runUpload({ zentaoUrl: zentao.url, mcpUrl: mock.url, credentialsFile, imagePath });
    assert.notEqual(run.code, 0, '字节对不上时必须非零退出');
    assert.match(run.stderr, /按未成功处理/);
  } finally {
    await mock.close();
    await zentao.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('图片文件不存在：直接失败，不发请求', async () => {
  const { dir, credentialsFile } = setup();
  const mock = await startMockServer();
  const zentao = await startFakeZentao();
  try {
    const run = await runUpload({
      zentaoUrl: zentao.url,
      mcpUrl: mock.url,
      credentialsFile,
      imagePath: path.join(dir, 'not-there.png'),
    });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /找不到图片文件/);
    assert.equal(zentao.state.uploads.length, 0, '不该发出上传请求');
  } finally {
    await mock.close();
    await zentao.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
