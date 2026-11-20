// 图片上传的测试：入口脚本（scripts/zentao.mjs）的 file-create 子命令在假禅道 API v2 服务上的行为。
// 运行：node --test tests/upload.mjs
//
// 关注点（只看脚本对禅道说了什么、Agent 拿到什么）：
//   - 图片挂到已存在的单据上，返回文件标识与正文用的图片引用
//   - 凭据与令牌不进输出
//   - 服务端拒绝、图片不存在都要明确失败，不假装图片已经放上去
//
// 迁移说明：旧上传脚本靠直连 REST v2 逐字节回读附件；官方禅道 CLI 没有 file get / file list，
// 回读字节这条路不存在。等价覆盖是 U05：上传后回读目标单据，确认正文里有那张图的引用
// （fileID 与上传返回一致）、附件挂载对象就是目标单据。「拿不到文件标识」的用例在
// tests/zentao-cli-file.mjs F06/F07 里覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MOCK_API_ACCOUNT,
  MOCK_API_ACCOUNTS,
  createMockApiState,
  startMockApi,
} from './mock-zentao-api.mjs';
import { ZentaoEntry, findZentaoCli } from './zentao-client.mjs';

const ZENTAO_CLI = findZentaoCli();
// 入口脚本靠官方禅道 CLI 传图；没装就别假装测过
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它传图，装好再跑这份测试';

const ACCOUNT = MOCK_API_ACCOUNT;
const CRED_VALUE = MOCK_API_ACCOUNTS[ACCOUNT];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function writeCredentials(dir) {
  const file = path.join(dir, 'credentials');
  fs.writeFileSync(file, `ZENTAO_ACCOUNT=${ACCOUNT}\nZENTAO_PASSWORD=${CRED_VALUE}\n`);
  return file;
}

/** 起假服务 + 临时图片 + 隔离的本机配置。 */
async function withMock({ image = true, ...overrides }, fn) {
  const server = await startMockApi(createMockApiState(overrides));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-upload-'));
  const packageConfig = path.join(dir, 'config.local.json');
  fs.writeFileSync(packageConfig, JSON.stringify({ zentaoWebUrl: server.url }));
  const imagePath = path.join(dir, 'shot.png');
  if (image) fs.writeFileSync(imagePath, PNG);
  const env = {
    ZENTAO_WEB_URL: server.url,
    ZENTAO_CREDENTIALS_FILE: writeCredentials(dir),
    ZENTAO_PACKAGE_CONFIG_FILE: packageConfig,
  };
  const zentao = new ZentaoEntry({ env });
  try {
    await fn({ zentao, server, state: server.state, env, dir, imagePath });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假服务收到的上传请求。 */
function uploads(state) {
  return state.calls.filter((c) => c.method === 'POST' && c.path === '/api.php/v2/files');
}

test('U01 上传成功：返回文件标识与图片引用，并核对服务端收到的多部分表单', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, imagePath }) => {
    const { code, data, stderr } = await zentao.fileCreate({ file: imagePath, objectType: 'feedback', objectId: 65 });
    assert.equal(code, 0, `上传应成功：${stderr}`);
    assert.equal(data.ok, true);
    assert.equal(data.fileId, 1);
    assert.equal(data.objectType, 'feedback');
    assert.equal(data.objectId, 65);
    assert.match(data.reference, /^<img src="\/index\.php\?m=file&f=read&t=png&fileID=1"/);

    // 上传请求确实带了内容与挂载对象
    assert.equal(uploads(state).length, 1);
    const [upload] = uploads(state);
    assert.match(String(upload.headers['content-type']), /multipart\/form-data/);
    assert.match(upload.body, /name="file"/);
    assert.match(upload.body, /name="objectType"[\s\S]*feedback/);
    assert.match(upload.body, /name="objectID"[\s\S]*65/);
  });
});

test('U02 凭据与令牌不进输出', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ zentao, state, imagePath }) => {
    const res = await zentao.run(['file-create', '--file', imagePath, '--object-type', 'feedback', '--object-id', '65']);
    assert.equal(res.code, 0);
    const printed = `${res.stdout}${res.stderr}`;
    assert.ok(!printed.includes(CRED_VALUE), '输出里不该出现密码');
    for (const token of state.tokens.keys()) {
      assert.ok(!printed.includes(token), '输出里不该出现令牌');
    }
  });
});

test('U03 禅道拒绝上传：报错并带上服务端原因，不当成成功', { skip: NEEDS_CLI }, async () => {
  await withMock({ failPaths: ['/api.php/v2/files'] }, async ({ zentao, imagePath }) => {
    const { code, data, stderr } = await zentao.fileCreate({ file: imagePath, objectType: 'feedback', objectId: 65 });
    assert.notEqual(code, 0, '被拒绝时必须非零退出');
    assert.equal(data.ok, false);
    assert.match(stderr, /传图失败/);
    assert.ok(!data.fileId, '失败时不该给出文件标识');
    assert.ok(!data.reference, '失败时不该给出图片引用');
  });
});

test('U04 图片文件不存在：直接失败，一个上传请求都不发', { skip: NEEDS_CLI }, async () => {
  await withMock({ image: false }, async ({ zentao, state, dir }) => {
    const { code, data, stderr } = await zentao.fileCreate({
      file: path.join(dir, 'not-there.png'),
      objectType: 'feedback',
      objectId: 65,
    });
    assert.notEqual(code, 0);
    assert.equal(data.ok, false);
    assert.match(stderr, /找不到图片文件/);
    assert.equal(uploads(state).length, 0, '不该发出上传请求');
  });
});

test('U05 上传后回读目标单据：正文里有那张图的引用，附件挂的就是这张单据', { skip: NEEDS_CLI }, async () => {
  // 官方 CLI 没有 file get / file list，无法逐字节回读附件；
  // 等价的覆盖是：回读目标单据，确认引用落在正文里、且附件挂载对象就是它。
  const original = '【业务场景】\n仓管每天下班前导出对账。';
  const record = {
    id: 65,
    product: 101,
    title: '导出按钮点击后无响应',
    desc: original,
    type: 'advice',
    status: 'wait',
    feedbackBy: ACCOUNT,
    openedBy: ACCOUNT,
    openedDate: '2026-11-20 10:00:00',
    actions: [{ id: 650, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
  };
  await withMock({ feedbacks: new Map([[record.id, record]]) }, async ({ zentao, state, imagePath }) => {
    const upload = await zentao.fileCreate({ file: imagePath, objectType: 'feedback', objectId: record.id });
    assert.equal(upload.code, 0, upload.stderr);

    const update = await zentao.updateFeedback(record.id, {
      product: record.product,
      title: record.title,
      desc: `${original}\n\n──────────────\n${upload.data.reference}`,
      expectedBody: original,
      appendLabel: '截图 1',
    });
    assert.equal(update.code, 0, update.stderr);
    assert.equal(update.data.updated, true);

    // 附件挂在目标单据上：上传请求带的 objectType / objectID 就是它，且只传了一次
    assert.equal(uploads(state).length, 1, '附件只传一次');
    const [sent] = uploads(state);
    assert.match(sent.body, /name="objectType"[\s\S]*feedback/);
    assert.match(sent.body, new RegExp(`name="objectID"[\\s\\S]*${record.id}`));

    // 回读目标单据：正文里有那张图的引用（fileID 与上传返回一致）
    const read = await zentao.feedback(record.id);
    assert.equal(read.code, 0, read.stderr);
    const stored = state.feedbacks.get(record.id).desc;
    assert.match(stored, /【截图 1】/);
    assert.ok(stored.includes(upload.data.reference), '正文里要有这张图的引用');
    assert.ok(stored.includes(`fileID=${upload.data.fileId}`), '引用的 fileID 与上传返回的文件标识一致');
    assert.match(read.data.body, /截图 1/, '详情回读看得到追加段落的标签');
    assert.equal(read.data.actions.filter((a) => a.action === 'edited').length, 1, '本次新增了「编辑」流水');
  });
});
