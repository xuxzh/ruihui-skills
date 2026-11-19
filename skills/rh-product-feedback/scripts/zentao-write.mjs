#!/usr/bin/env node
// 禅道写入脚本（rh-product-feedback 随包脚本）：建单据、更新单据。
//
// 为什么不用宿主里的禅道 MCP 工具写：实测该服务端的 post_users_login 不校验传入凭据，
// 恒以服务端配置的固定身份对外服务，经宿主工具提交的单据留痕在那个账号名下，
// 而不是提交人自己（见 docs/adr/0015）。宿主工具没法带调用方自己的禅道令牌，
// 但这个脚本可以——它用本机凭据直连禅道换一个用户令牌，再带着令牌调禅道 MCP。
//
// 纪律：
//   - 一次调用只发一次请求：禅道创建接口没有幂等键，重复发会产生两条记录
//   - 令牌与密码只在进程内使用，不打印、不进 Agent 上下文
//   - 载荷由调用方给（文件或内联 JSON），脚本只包 payload、只发一次、不做业务判断
//
// 用法：
//   node zentao-write.mjs feedback-create --payload-file <路径>
//   node zentao-write.mjs feedback-update --id <ID> --payload-file <路径>
//   node zentao-write.mjs bug-create --payload-file <路径>
//   node zentao-write.mjs bug-update --id <ID> --payload-file <路径>

import fs from 'node:fs';
import { connectAsUser } from './zentao-client.mjs';

/** 子命令 → MCP 工具名、ID 参数名、必填字段。 */
const KINDS = {
  'feedback-create': { tool: 'post_feedbacks', idKey: null, required: ['product', 'title'], label: '反馈单' },
  'feedback-update': { tool: 'put_feedbacks_feedbackID', idKey: 'feedbackID', required: ['product', 'title'], label: '反馈单' },
  'bug-create': { tool: 'post_bugs', idKey: null, required: ['productID', 'title', 'openedBuild'], label: '缺陷单' },
  'bug-update': { tool: 'put_bugs_bugID', idKey: 'bugID', required: ['productID', 'title'], label: '缺陷单' },
};

const HELP = `禅道写入脚本（rh-product-feedback）

  feedback-create --payload-file <路径>    创建反馈单
  feedback-update --id <ID> --payload-file <路径>   更新反馈单
  bug-create      --payload-file <路径>    创建缺陷单
  bug-update      --id <ID> --payload-file <路径>   更新缺陷单

载荷选项（三选一）：--payload-file <路径>（推荐）  --payload '<JSON>'  --payload-stdin
载荷文件里放 payload 的内容本身，不要再套一层 payload。

输出：stdout 一行 JSON，例如 {"ok":true,"kind":"bug","id":1945,"status":"success","message":"保存成功"}
失败：stderr 一行「错误：…」，退出码非 0。`;

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

/** 读载荷：文件 / 内联 JSON / stdin。 */
function readPayload(opts) {
  if (opts['payload-stdin']) {
    return readStdin();
  }
  if (opts['payload-file']) {
    const file = String(opts['payload-file']);
    if (!fs.existsSync(file)) throw new Error(`载荷文件不存在：${file}`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`读不到载荷文件：${err?.message || err}`);
    }
    return parsePayload(text);
  }
  if (opts.payload) return parsePayload(String(opts.payload));
  throw new Error('没有载荷：用 --payload-file <路径>、--payload <JSON> 或 --payload-stdin 其中一种');
}

function readStdin() {
  try {
    return parsePayload(fs.readFileSync(0, 'utf8'));
  } catch (err) {
    throw new Error(`从 stdin 读载荷失败：${err?.message || err}`);
  }
}

function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('载荷不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('载荷必须是一个 JSON 对象');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
    throw new Error('载荷文件里放 payload 的内容本身，不要再套一层 payload（脚本会自己包）');
  }
  return data;
}

/** 必填字段自检：与服务端校验一致，只是为了早点给出人话错误。 */
function checkRequired(kind, payload) {
  const missing = kind.required.filter((key) => {
    const value = payload[key];
    if (value === undefined || value === null || value === '') return true;
    if (key === 'openedBuild') return !Array.isArray(value) || value.length === 0;
    return false;
  });
  if (missing.length) {
    throw new Error(`载荷缺必填字段：${missing.join('、')}`);
  }
}

function fail(message, extra = {}) {
  process.stderr.write(`错误：${message}\n`);
  const payload = { ok: false, ...extra, message };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}

async function main() {
  const [command] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const kind = KINDS[command];
  if (!kind) {
    process.stdout.write(`${HELP}\n`);
    throw new Error(`未知命令：${command}`);
  }

  const { opts } = parseArgs(process.argv.slice(3));
  const payload = readPayload(opts);
  checkRequired(kind, payload);

  const args = {};
  if (kind.idKey) {
    const id = String(opts.id ?? '').trim();
    if (!id) throw new Error(`更新${kind.label}要带 --id <单据 ID>`);
    args[kind.idKey] = id;
  }
  args.payload = payload;

  const { client } = await connectAsUser();
  const res = await client.call(kind.tool, args);

  const body = res.body;
  const status = body?.status;
  const id = body?.id;
  const message = typeof body?.message === 'string' ? body.message : '';

  if (!body || (status !== 'success' && status !== undefined)) {
    // 没有可解析的业务状态 → 结果不确定，交给调用方按「先查后报」处理
    fail('禅道没有返回可解析的业务状态，按结果不确定处理：不要重发写入，先回读核实', {
      kind: command,
      uncertain: true,
    });
    return;
  }

  if (status !== 'success') {
    fail(message || '禅道返回业务失败', { kind: command, status });
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind: command,
    id: id === undefined ? null : String(id),
    status,
    message,
  })}\n`);
}

main().catch((err) => {
  fail(err?.message || String(err));
});
