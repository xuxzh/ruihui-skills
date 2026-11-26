import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_ACCOUNT, MOCK_API_ACCOUNTS } from './mock-zentao-api.mjs';
import { findZentaoCli, installCliShim, runEntryScript, withMockApi } from './zentao-client.mjs';

const ACCOUNT = MOCK_API_ACCOUNT;
const PASSWORD = MOCK_API_ACCOUNTS[ACCOUNT];

const ZENTAO_CLI = findZentaoCli();
const NEEDS_CLI = ZENTAO_CLI ? false : '没装禅道 CLI（npm i -g zentao-cli）：入口脚本靠它写数，装好再跑这份测试';

const withMock = (opts, fn) =>
  withMockApi({ tag: 'rh-cli-issue', ...opts }, fn);

function issuePayload(overrides = {}) {
  return {
    objectID: 11,
    title: '第三方接口联调环境网络经常中断',
    type: 'version',
    severity: 2,
    pri: 2,
    desc: '联调环境最近两周经常无法访问，影响业务联调进度。',
    ...overrides,
  };
}

function writePayload(dir, payload) {
  const file = path.join(dir, `payload-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function creates(server) {
  return server.state.calls.filter((call) => call.method === 'POST' && call.path === '/api.php/v2/issues');
}

function createdBody(server) {
  const [call] = creates(server);
  return JSON.parse(call.body);
}

function readsOf(server, id) {
  return server.state.calls.filter((call) => call.method === 'GET' && call.path === `/api.php/v2/issues/${id}`);
}

function singleLineJson(stdout) {
  const text = stdout.trim();
  assert.equal(text.split('\n').length, 1, `stdout 应是一行 JSON：${text}`);
  return JSON.parse(text);
}

test('I01 建单成功：只发一次创建请求，回读核对通过后交付编号/状态/项目/类型/严重程度/链接', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, issuePayload());
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'issue');
    assert.equal(result.id, 2900);
    assert.equal(result.project, 11);
    assert.equal(result.title, '第三方接口联调环境网络经常中断');
    assert.equal(result.type, 'version');
    assert.equal(result.severity, 2);
    assert.equal(result.url, `${server.url}/issue-view-2900.html`);
    assert.equal(result.verified, 'readback');

    assert.equal(creates(server).length, 1, '创建请求只能发一次');
    assert.equal(readsOf(server, 2900).length, 1, '写入后要按返回的编号回读一次');
    assert.ok(!fs.existsSync(file), '临时载荷文件用完要删掉');

    const body = createdBody(server);
    assert.equal(body.objectID, 11);
    assert.equal(body.from, 0);
    assert.equal(body.owner, ACCOUNT);
  });
});

test('I02 正文不进命令行参数：载荷经文件、以 --data @<路径> 交给 CLI', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const file = writePayload(dir, issuePayload());
    const shim = installCliShim(dir, ZENTAO_CLI);
    const { code, stderr } = await runEntryScript(['issue-create', '--payload-file', file], { ...env, ...shim.env });
    assert.equal(code, 0, stderr);

    const argvList = shim.calls();
    const createArgv = argvList.find((argv) => argv.includes('create'));
    assert.ok(createArgv, '应该调起过 issue create');
    assert.equal(createArgv[createArgv.indexOf('--data') + 1], `@${file}`);
    for (const argv of argvList) {
      const joined = argv.join(' ');
      assert.ok(!joined.includes('第三方接口联调环境'), `正文不该出现在命令行参数里：${joined}`);
    }
  });
});

test('I03 服务端业务失败：如实报错，不重发', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, issuePayload({ title: '__FAIL__ 第三方接口联调环境中断' }));
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /^错误：禅道 CLI 报错/m);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 1, '失败不重发');
  });
});

test('I04 回读核对不通过：正文被服务端改写就报不一致，不重建', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, issuePayload({ title: '__ALTERED_DESC__ 接口环境中断' }));
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /回读核对没通过（项目问题 #2900 已经写入）：描述与载荷不一致/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'issue');
    assert.equal(result.id, 2900);
    assert.equal(result.created, true);
    assert.deepEqual(result.mismatches, ['描述']);
    assert.equal(creates(server).length, 1, '回读失败不重建');
  });
});

test('I05 载荷缺必填字段：一个写请求都不发，错误点名缺哪项', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, { title: '只有标题' });
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷缺必填字段：objectID、type、severity/);
    assert.equal(singleLineJson(stdout).ok, false);
    assert.equal(creates(server).length, 0);
  });
});

test('I06 没给 --payload-file：按用法错误退 2，不查禅道', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const { code, stderr } = await runEntryScript(['issue-create'], env);
    assert.equal(code, 2);
    assert.match(stderr, /^错误：用法：.*issue-create --payload-file/);
    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('I07 结果不确定（超时）：不重发，查询核实到唯一一致的新记录后按创建成功交付', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    const file = writePayload(dir, issuePayload({ title: '__TIMEOUT__ 第三方接口联调中断' }));
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 2900);
    assert.equal(result.verified, 'query');
    assert.equal(creates(server).length, 1, '创建只发一次，即使超时也不重发');
  });
});

test('I08 结果不确定（保存成功但查不到）：报未确认，不把「没查到」说成「没创建」', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env, dir }) => {
    server.state.hangPaths = ['/api.php/v2/issues'];
    server.state.createHang = 'ghost';
    const file = writePayload(dir, issuePayload({ title: '超时且没落库的问题' }));
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /创建请求结果不确定.*重查项目 11 也没找到与载荷一致的新记录.*是否建成未确认/);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.id, null);
    assert.deepEqual(result.candidates, []);
    assert.equal(creates(server).length, 1, '超时不重发');
  });
});

test('I09 项目问题列表：issues --project <ID>，表格输出，原始 JSON 不进上下文', { skip: NEEDS_CLI }, async () => {
  await withMock(
    {
      seed: (state) => {
        state.issues.set(2901, {
          id: 2901,
          title: '设计规范与前端组件库不统一',
          status: 'open',
          assignedTo: 'mock-qd',
          type: 'design',
          severity: 3,
          pri: 3,
          project: 11,
        });
      },
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(['issues', '--project', '11'], env);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /^# 项目问题（项目 11 可见 1 条，已扫 1 条）$/m);
      assert.match(stdout, /^2901\t设计规范与前端组件库不统一\topen\tmock-qd\tdesign\t3\/3$/m);
      assert.ok(!stdout.includes('{'), '原始 JSON 不进上下文');
    }
  );
});

test('I10 项目问题列表客户端筛选：issues --project <ID> --match <关键词>', { skip: NEEDS_CLI }, async () => {
  await withMock(
    {
      seed: (state) => {
        state.issues.set(2901, {
          id: 2901,
          title: '设计规范与前端组件库不统一',
          status: 'open',
          assignedTo: 'mock-qd',
          type: 'design',
          severity: 3,
          pri: 3,
          project: 11,
        });
        state.issues.set(2902, {
          id: 2902,
          title: '接口数据格式校验不严格',
          status: 'closed',
          assignedTo: 'dev-a',
          type: 'data',
          severity: 2,
          pri: 2,
          project: 11,
        });
      },
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(['issues', '--project', '11', '--match', '规范'], env);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /筛选后 1 条/);
      assert.match(stdout, /2901\t设计规范与前端组件库不统一/);
      assert.ok(!stdout.includes('2902'));
    }
  );
});

test('I11 项目问题详情：issue --id <ID>，返回一行 JSON，包含状态、负责人、提出人、类型、严重程度、优先级、计划解决日期、正文', { skip: NEEDS_CLI }, async () => {
  await withMock(
    {
      seed: (state) => {
        state.issues.set(2901, {
          id: 2901,
          title: '排期延误风险',
          status: 'open',
          assignedTo: 'dev-leader',
          owner: ACCOUNT,
          type: 'version',
          severity: 1,
          pri: 1,
          project: 11,
          execution: 0,
          deadline: '2026-12-01',
          desc: '<p>由于核心依赖库升级出现兼容性问题，排期预计延后 3 天。</p>',
          actions: [{ id: 29010, action: 'opened', actor: ACCOUNT, date: '2026-11-20 10:00:00', comment: '' }],
        });
      },
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(['issue', '--id', '2901'], env);
      assert.equal(code, 0, stderr);

      const result = singleLineJson(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'issue');
      assert.equal(result.id, 2901);
      assert.equal(result.project, 11);
      assert.equal(result.title, '排期延误风险');
      assert.equal(result.status, 'open');
      assert.equal(result.assignee, 'dev-leader');
      assert.equal(result.owner, ACCOUNT);
      assert.equal(result.type, 'version');
      assert.equal(result.severity, 1);
      assert.equal(result.pri, 1);
      assert.equal(result.deadline, '2026-12-01');
      assert.match(result.body, /由于核心依赖库升级出现兼容性问题/);
      assert.equal(result.actions.length, 1);
    }
  );
});

test('I12 查重：dup --kind issue --project <ID> --title <标题>，扫目标项目的项目问题标题，输出候选与基线', { skip: NEEDS_CLI }, async () => {
  await withMock(
    {
      seed: (state) => {
        state.issues.set(2901, {
          id: 2901,
          title: '第三方联调环境不稳定',
          status: 'open',
          assignedTo: 'dev-a',
          type: 'version',
          severity: 2,
          pri: 2,
          project: 11,
        });
      },
    },
    async ({ env }) => {
      const { code, stdout, stderr } = await runEntryScript(
        ['dup', '--kind', 'issue', '--project', '11', '--title', '第三方联调环境经常中断'],
        env
      );
      assert.equal(code, 0, stderr);
      assert.match(stdout, /# 查重（项目 11 · 项目问题；标题关键词匹配，客户端完成）/);
      assert.match(stdout, /2901\t第三方联调环境不稳定/);
      assert.match(stdout, /# 基线（本次扫描到的 1 个单据 ID/);

      const lines = stdout.trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      assert.equal(last.ok, true);
      assert.equal(last.kind, 'issue');
      assert.equal(last.project, 11);
      assert.deepEqual(last.baseline, [2901]);
      assert.deepEqual(last.candidateIds, [2901]);
    }
  );
});

test('I13 type 不合法：报错点名合法枚举', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ env, dir }) => {
    const file = writePayload(dir, issuePayload({ type: 'invalid_type' }));
    const { code, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.notEqual(code, 0);
    assert.match(stderr, /载荷的 type「invalid_type」不合法/);
  });
});

test('I14 查重选项不许串用：项目问题只认 --project，缺陷 / 反馈只认 --product', { skip: NEEDS_CLI }, async () => {
  await withMock({}, async ({ server, env }) => {
    const issue = await runEntryScript(['dup', '--kind', 'issue', '--product', '101', '--title', '联调环境中断'], env);
    assert.equal(issue.code, 2);
    assert.match(issue.stderr, /dup --kind issue 用 --project <项目ID>，不带 --product/);

    const bug = await runEntryScript(['dup', '--kind', 'bug', '--project', '11', '--title', '导出按钮没反应'], env);
    assert.equal(bug.code, 2);
    assert.match(bug.stderr, /dup --kind bug 用 --product <产品ID>，不带 --project/);
    assert.equal(server.state.calls.filter((call) => call.path.startsWith('/api.php/v2/')).length, 0);
  });
});

test('I15 回读没有 actions（真实 CLI 0.4.4 形状）：createdBy / createdDate 可核对就判成功', { skip: NEEDS_CLI }, async () => {
  await withMock({ omitActions: true }, async ({ env, dir }) => {
    const file = writePayload(dir, issuePayload());
    const { code, stdout, stderr } = await runEntryScript(['issue-create', '--payload-file', file], env);
    assert.equal(code, 0, stderr);

    const result = singleLineJson(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.id, 2900);
    assert.equal(result.verified, 'readback');
  });
});
