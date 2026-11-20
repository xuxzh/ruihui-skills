// 运行：node --test tests/setup-cli-pin.mjs
//
// 首次接入（issue #23）的静态约束：官方禅道 CLI 的版本钉在技能包接入配置里，
// 文档只认这个值；接入凭据脚本只认本人的交互式输入。
// 这条链路一断，Agent 就会装成 latest 或根本读不到版本，所以钉在这里。

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'rh-product-feedback');
const SETUP = path.join(SKILL_DIR, 'references', 'setup.md');
const QUICK_START = path.join(ROOT, 'docs', 'quick-start.md');
const CREDENTIALS_SH = path.join(SKILL_DIR, 'scripts', 'set-credentials.sh');

const read = (file) => fs.readFileSync(file, 'utf8');

test('接入配置钉住官方禅道 CLI 的包名与版本', () => {
  const config = JSON.parse(read(path.join(SKILL_DIR, 'config.local.json')));
  assert.ok(config.zentaoCli, '缺 zentaoCli 字段');
  assert.equal(config.zentaoCli.package, 'zentao-cli');
  assert.match(String(config.zentaoCli.version), /^\d+\.\d+\.\d+$/, '版本要钉成 x.y.z，不能用范围或 latest');
});

test('setup.md 的装 CLI 动作认接入配置，而不是写死 latest', () => {
  const setup = read(SETUP);
  assert.match(setup, /zentaoCli\.version/, '要说明版本来自接入配置');
  assert.match(setup, /npm install -g zentao-cli@/, '要给出按固定版本安装的命令');
  assert.doesNotMatch(setup, /npm install -g zentao-cli(@latest)?\s*$/m, '不能装 latest');
});

test('首次接入的自检只读，且报的是当前账号可见的产品', () => {
  const setup = read(SETUP);
  assert.match(setup, /scripts\/zentao\.mjs products/, '自检要跑入口脚本的 products');
  assert.match(setup, /只读/, '自检要写清只读');
  assert.match(setup, /禅道网页端/, '装不上时要给网页端的替代路径');
  assert.match(setup, /不退回用宿主里的禅道 MCP 工具建单|不要退回用宿主里的禅道 MCP 工具建单/);
});

test('首次接入不再登记禅道 MCP，且说明它是服务端固定身份', () => {
  const setup = read(SETUP);
  assert.match(setup, /不再登记禅道 MCP/);
  assert.match(setup, /服务端配置的固定身份/);
});

test('速查的安装提示词由 Agent 代装 CLI，凭据仍由本人输入', () => {
  const quick = read(QUICK_START);
  const prompt = quick.match(/```\n(帮我把 ruihui 的产品反馈助手[\s\S]*?)```/);
  assert.ok(prompt, '速查里找不到安装提示词');
  assert.match(prompt[1], /zentaoCli\.version/, '提示词要让 Agent 按接入配置装固定版本');
  assert.doesNotMatch(prompt[1], /登记禅道 MCP/, '提示词不该再让用户登记禅道 MCP');
  assert.match(prompt[1], /密码只由我本人输入/, '凭据必须由本人输入');
  assert.match(prompt[1], /connect\.mjs/, '凭据走本机页面写入，不让用户离开对话去开终端');
  assert.match(prompt[1], /已经装过就更新到最新/, '同一段提示词要能用于首装与重装');
  assert.match(prompt[1], /你自己判断，不用问我/, '版本判断由 Agent 做，不问终端用户');
  assert.match(prompt[1], /Node\.js 18/, '提示词要先确认 Node.js，没有就装');
  assert.match(
    prompt[1],
    /https:\/\/github\.com\/xuxzh\/ruihui-skills/,
    '提示词必须写明来源，Agent 才不用去别处乱找',
  );
  assert.match(
    prompt[1],
    /npx skills add xuxzh\/ruihui-skills --skill rh-product-feedback --global/,
    '提示词必须给出装技能的命令',
  );
});

test('凭据脚本写明只做交互式写入，且认三个凭据键', () => {
  const script = read(CREDENTIALS_SH);
  for (const key of ['ZENTAO_ACCOUNT', 'ZENTAO_PASSWORD', 'ZENTAO_TOKEN']) {
    assert.match(script, new RegExp(key), `脚本要提到 ${key}`);
  }
  assert.match(script, /交互式/, '要写清只做交互式写入');
});
