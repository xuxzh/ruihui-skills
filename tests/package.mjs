// 技能目录与随包脚本的测试。
// 运行：node --test tests/package.mjs
//
// 覆盖：随包分发哪些文件、旧的直连实现是否下线、入口脚本的命令面、
// 凭据脚本的行为、仓库里是否只有一条发布线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'rh-product-feedback');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const CREDENTIAL_SH = path.join(SCRIPTS_DIR, 'set-credentials.sh');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('技能目录随包分发入口脚本、查重助手与凭据脚本（skills.sh 装的就是这个目录）', () => {
  for (const script of ['set-credentials.sh', 'set-credentials.ps1', 'zentao.mjs', 'zentao-dedupe.mjs']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, script)), `技能目录缺 scripts/${script}`);
  }
});

// 不并存原则：旧的直连实现与三支旧脚本都下线，包里只剩一条通道。
test('技能目录不再带着旧的直连实现', () => {
  for (const script of ['zentao-query.mjs', 'zentao-query.sh', 'zentao-query.ps1', 'zentao-write.mjs', 'zentao-upload.mjs', 'zentao-client.mjs']) {
    assert.ok(!fs.existsSync(path.join(SCRIPTS_DIR, script)), `scripts/${script} 应已删除`);
  }
  assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'references', 'zentao-mcp.md')), 'references/zentao-mcp.md 应已删除');
});

test('技能目录不再随包分发安装脚本（装 CLI 交给当前宿主里的 Agent）', () => {
  for (const script of ['install.sh', 'install.ps1']) {
    assert.ok(!fs.existsSync(path.join(SCRIPTS_DIR, script)), `scripts/${script} 应已删除`);
  }
});

test('入口脚本随包分发且 --help 列出全部子命令', () => {
  const stdout = execFileSync('node', [path.join(SCRIPTS_DIR, 'zentao.mjs'), '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const cmd of [
    'products',
    'projects',
    'bugs',
    'feedbacks',
    'issues',
    'bug',
    'feedback',
    'issue',
    'bug-create',
    'feedback-create',
    'issue-create',
    'bug-update',
    'feedback-update',
    'bug-resolve',
    'bug-close',
    'bug-activate',
    'feedback-close',
    'feedback-activate',
    'file-create',
    'dup',
  ]) {
    assert.match(stdout, new RegExp(`^\\s+${cmd}\\b`, 'm'), `--help 里要列出 ${cmd}`);
  }
});

// 发布线只有一条：仓库里不留第二份技能副本，也不再有内网打包脚本。
test('仓库里没有第二份技能副本，也没有内网打包脚本', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.doesNotMatch(tracked, /^dist\//m, '仓库里不应跟踪内网产物目录');
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'scripts', 'build-internal-package.mjs')),
    '内网打包脚本已下线：发布线只有 skills.sh 一条',
  );
});

test('凭据脚本：--path 打印凭据文件位置', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const stdout = execFileSync('bash', [CREDENTIAL_SH, '--path'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(stdout.trim(), path.join(home, '.config', 'rh-zentao', 'credentials'));
});

test('凭据脚本：写入只有本人可读的凭据文件', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const secret = ['test', 'password', 'value'].join('-');
  execFileSync('bash', [CREDENTIAL_SH], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: `zhangsan\n${secret}\n`,
  });
  const target = path.join(home, '.config', 'rh-zentao', 'credentials');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /^ZENTAO_ACCOUNT=zhangsan$/m);
  assert.match(content, new RegExp(`^ZENTAO_PASSWORD=${secret}$`, 'm'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, '凭据文件权限应为 600');
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700, '凭据目录权限应为 700');
});

test('凭据脚本：--token 写入令牌而不是密码', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const secret = ['test', 'token', 'value'].join('-');
  execFileSync('bash', [CREDENTIAL_SH, '--token'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: `zhangsan\n${secret}\n`,
  });
  const content = fs.readFileSync(path.join(home, '.config', 'rh-zentao', 'credentials'), 'utf8');
  assert.match(content, new RegExp(`^ZENTAO_TOKEN=${secret}$`, 'm'));
  assert.doesNotMatch(content, /PASSWORD/);
});
