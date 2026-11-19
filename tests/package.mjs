// 打包脚本与随包脚本的测试。
// 运行：node --test tests/package.mjs
//
// 覆盖：打包产物的结构与内容、地址来源与失败路径、凭据脚本的行为、仓库约定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGER = path.join(ROOT, 'scripts', 'build-internal-package.mjs');
const SKILL_DIR = path.join(ROOT, 'skills', 'rh-product-feedback');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const CREDENTIAL_SH = path.join(SCRIPTS_DIR, 'set-credentials.sh');

const WEB_URL = 'https://zentao.example.test';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pack(outDir, args = []) {
  return execFileSync('node', [PACKAGER, '--out', outDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('打包产物是一个顶层自洽的技能目录', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--web-url', WEB_URL]);
  const pkg = path.join(out, 'rh-product-feedback');

  assert.ok(fs.existsSync(path.join(pkg, 'SKILL.md')), '缺 SKILL.md');
  assert.ok(fs.existsSync(path.join(pkg, 'references', 'setup.md')), '缺 references/');
  assert.ok(fs.existsSync(path.join(pkg, 'config.local.json')), '缺 config.local.json');
  for (const script of ['set-credentials.sh', 'set-credentials.ps1', 'zentao.mjs', 'zentao-dedupe.mjs']) {
    assert.ok(fs.existsSync(path.join(pkg, 'scripts', script)), `缺 scripts/${script}`);
  }
  // 旧的直连实现与三支旧脚本已下线，包里不应再有它们（不并存原则落到终态）
  for (const script of ['zentao-query.mjs', 'zentao-query.sh', 'zentao-query.ps1', 'zentao-write.mjs', 'zentao-upload.mjs', 'zentao-client.mjs']) {
    assert.ok(!fs.existsSync(path.join(pkg, 'scripts', script)), `scripts/${script} 应已下线`);
  }
  assert.ok(!fs.existsSync(path.join(pkg, 'references', 'zentao-mcp.md')), 'references/zentao-mcp.md 应已下线');

  // 技能文件与仓库里的一致
  assert.equal(
    fs.readFileSync(path.join(pkg, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'),
  );

  // 打包产物里不能有凭据
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(pkg);
  for (const file of files) {
    const name = path.basename(file);
    assert.notEqual(name, 'credentials', '打包产物里不应出现凭据文件');
    assert.notEqual(name, '.env', '打包产物里不应出现 .env');
  }

  // 接入配置里只有地址与随包默认值，没有凭据字段
  const config = JSON.parse(fs.readFileSync(path.join(pkg, 'config.local.json'), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['bugAssignee', 'defaultProduct', 'mcpUrl', 'zentaoCli', 'zentaoWebUrl']);
  // 自研禅道 MCP 降级为「给人手动查看」：地址随包带着，但技能卡片里的接入通道只有禅道 CLI
  assert.match(config.mcpUrl, /^https?:\/\//, 'mcpUrl 是给人手动查看用的地址来源');
  const skillMd = fs.readFileSync(path.join(pkg, 'SKILL.md'), 'utf8');
  assert.ok(!skillMd.includes(config.mcpUrl), '技能文档不写这个地址（技能不读它、不依赖它）');
  assert.equal(config.defaultProduct.id, null, '没预置时随包默认产品是空位');
});

test('打包时用传入的地址写 config.local.json，不带仓库里的旧值', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--web-url', WEB_URL]);
  const config = JSON.parse(
    fs.readFileSync(path.join(out, 'rh-product-feedback', 'config.local.json'), 'utf8'),
  );
  assert.equal(config.zentaoWebUrl, WEB_URL);
});

test('打包时带上仓库里预置的随包默认产品', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--web-url', WEB_URL]);
  const config = JSON.parse(
    fs.readFileSync(path.join(out, 'rh-product-feedback', 'config.local.json'), 'utf8'),
  );
  const repoConfig = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, 'config.local.json'), 'utf8'),
  );
  assert.deepEqual(config.defaultProduct, repoConfig.defaultProduct);
});

test('打包时带上仓库里预置的随包默认负责人', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--web-url', WEB_URL]);
  const config = JSON.parse(
    fs.readFileSync(path.join(out, 'rh-product-feedback', 'config.local.json'), 'utf8'),
  );
  const repoConfig = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, 'config.local.json'), 'utf8'),
  );
  assert.equal(config.bugAssignee, repoConfig.bugAssignee);
  assert.equal(config.bugAssignee, '', '随包默认负责人是不指派');
});

test('打包时把官方禅道 CLI 的版本锁带进包里', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--web-url', WEB_URL]);
  const config = JSON.parse(
    fs.readFileSync(path.join(out, 'rh-product-feedback', 'config.local.json'), 'utf8'),
  );
  const repoConfig = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, 'config.local.json'), 'utf8'),
  );
  assert.deepEqual(config.zentaoCli, repoConfig.zentaoCli);
  assert.equal(config.zentaoCli.package, 'zentao-cli');
  assert.match(config.zentaoCli.version, /^\d+\.\d+\.\d+$/, '版本锁是具体版本，不是范围');
});

test('打包不把内网地址打印到终端输出里', () => {
  const out = tmpDir('rh-pkg-');
  const stdout = pack(out, ['--web-url', WEB_URL]);
  assert.doesNotMatch(stdout, new RegExp(WEB_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('地址为空时打包失败，并给出可执行的提示', () => {
  const out = tmpDir('rh-pkg-');
  assert.throws(
    () => pack(out, ['--web-url', '']),
    (err) => /web-url|地址/.test(err.stderr ?? '') || /web-url|地址/.test(err.message ?? ''),
  );
});

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
    'bug',
    'feedback',
    'bug-create',
    'feedback-create',
    'bug-update',
    'feedback-update',
    'file-create',
    'dup',
  ]) {
    assert.match(stdout, new RegExp(`^\\s+${cmd}\\b`, 'm'), `--help 里要列出 ${cmd}`);
  }
});

test('打包产物目录在 .gitignore 里，避免内网地址被提交', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^dist\/$/m);
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
  execFileSync('bash', [CREDENTIAL_SH], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: 'zhangsan\ntest-password-value\n',
  });
  const target = path.join(home, '.config', 'rh-zentao', 'credentials');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /^ZENTAO_ACCOUNT=zhangsan$/m);
  assert.match(content, /^ZENTAO_PASSWORD=test-password-value$/m);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, '凭据文件权限应为 600');
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700, '凭据目录权限应为 700');
});

test('凭据脚本：--token 写入令牌而不是密码', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  execFileSync('bash', [CREDENTIAL_SH, '--token'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: 'zhangsan\ntest-token-value\n',
  });
  const content = fs.readFileSync(path.join(home, '.config', 'rh-zentao', 'credentials'), 'utf8');
  assert.match(content, /^ZENTAO_TOKEN=test-token-value$/m);
  assert.doesNotMatch(content, /PASSWORD/);
});
