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
const CREDENTIAL_SH = path.join(ROOT, 'scripts', 'set-credentials.sh');
const SKILL_DIR = path.join(ROOT, 'skills', 'rh-product-feedback');

const MCP_URL = 'https://mcp.example.test/mcp';
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
  pack(out, ['--mcp-url', MCP_URL, '--web-url', WEB_URL]);
  const pkg = path.join(out, 'rh-product-feedback');

  assert.ok(fs.existsSync(path.join(pkg, 'SKILL.md')), '缺 SKILL.md');
  assert.ok(fs.existsSync(path.join(pkg, 'references', 'setup.md')), '缺 references/');
  assert.ok(fs.existsSync(path.join(pkg, 'config.local.json')), '缺 config.local.json');
  for (const script of ['set-credentials.sh', 'set-credentials.ps1', 'connect.sh', 'connect.ps1']) {
    assert.ok(fs.existsSync(path.join(pkg, 'scripts', script)), `缺 scripts/${script}`);
  }

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

  // 接入配置里只有地址，没有凭据字段
  const config = JSON.parse(fs.readFileSync(path.join(pkg, 'config.local.json'), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['mcpUrl', 'zentaoWebUrl']);
});

test('打包时用传入的地址写 config.local.json，不带仓库里的旧值', () => {
  const out = tmpDir('rh-pkg-');
  pack(out, ['--mcp-url', MCP_URL, '--web-url', WEB_URL]);
  const config = JSON.parse(
    fs.readFileSync(path.join(out, 'rh-product-feedback', 'config.local.json'), 'utf8'),
  );
  assert.equal(config.mcpUrl, MCP_URL);
  assert.equal(config.zentaoWebUrl, WEB_URL);
});

test('打包不把内网地址打印到终端输出里', () => {
  const out = tmpDir('rh-pkg-');
  const stdout = pack(out, ['--mcp-url', MCP_URL, '--web-url', WEB_URL]);
  assert.doesNotMatch(stdout, new RegExp(MCP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('地址为空时打包失败，并给出可执行的提示', () => {
  const out = tmpDir('rh-pkg-');
  assert.throws(
    () => pack(out, ['--mcp-url', '']),
    (err) => /mcp-url|地址/.test(err.stderr ?? '') || /mcp-url|地址/.test(err.message ?? ''),
  );
});

test('技能目录里不放随包脚本（仓库约定：技能目录只放技能本身与接入配置）', () => {
  assert.equal(fs.existsSync(path.join(SKILL_DIR, 'scripts')), false);
  assert.equal(fs.existsSync(path.join(SKILL_DIR, 'set-credentials.sh')), false);
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
    input: 'zhangsan\ntest-token-value\n',
  });
  const target = path.join(home, '.config', 'rh-zentao', 'credentials');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /^ZENTAO_ACCOUNT=zhangsan$/m);
  assert.match(content, /^ZENTAO_TOKEN=test-token-value$/m);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, '凭据文件权限应为 600');
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700, '凭据目录权限应为 700');
});
