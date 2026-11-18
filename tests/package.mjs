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
const INSTALL_SH = path.join(SCRIPTS_DIR, 'install.sh');

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
  for (const script of ['install.sh', 'install.ps1', 'set-credentials.sh', 'set-credentials.ps1']) {
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

test('技能目录随包分发安装脚本（skills.sh 装的就是这个目录）', () => {
  for (const script of ['install.sh', 'install.ps1', 'set-credentials.sh', 'set-credentials.ps1']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, script)), `技能目录缺 scripts/${script}`);
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

// --- 安装脚本 -----------------------------------------------------------

/** 造一个假的宿主 CLI：记录被调用的参数，按剧本回答。 */
function fakeHostBin(home, { claudeRunning = false } = {}) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(home, 'host-calls.log');

  const claude = path.join(bin, 'claude');
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env bash
echo "claude $*" >> "${log}"
case "$1 $2" in
  "mcp get") exit 1 ;;
  "mcp add") exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  const pi = path.join(bin, 'pi');
  fs.writeFileSync(
    pi,
    `#!/usr/bin/env bash
echo "pi $*" >> "${log}"
case "$1 $2" in
  "mcp list") exit 1 ;;
  "mcp add") exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  // 假的 pgrep：让「宿主是否在运行」只由测试决定，不受本机真实进程影响
  const pgrep = path.join(bin, 'pgrep');
  fs.writeFileSync(pgrep, `#!/usr/bin/env bash\nexit ${claudeRunning ? 0 : 1}\n`, { mode: 0o755 });

  return { bin, log };
}

test('安装脚本：装技能、登记禅道 MCP，且不回显地址', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin, log } = fakeHostBin(home);

  const stdout = execFileSync('bash', [INSTALL_SH, '--skip-credentials'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  // 技能被装进两个宿主目录
  for (const dir of ['.claude/skills', '.agents/skills']) {
    assert.ok(
      fs.existsSync(path.join(home, dir, 'rh-product-feedback', 'SKILL.md')),
      `技能没装到 ${dir}`,
    );
    assert.ok(
      fs.existsSync(path.join(home, dir, 'rh-product-feedback', 'scripts', 'install.sh')),
      `安装脚本没随技能装到 ${dir}`,
    );
  }

  // 两个宿主都登记了禅道 MCP
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /claude mcp add --transport http zentao /);
  assert.match(calls, /pi mcp add zentao --url /);

  // 地址不打印到终端输出里
  const mcpUrl = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.local.json'), 'utf8')).mcpUrl;
  assert.doesNotMatch(stdout, new RegExp(mcpUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // 收尾提示：重启 + 验证
  assert.match(stdout, /重启你的 AI Agent/);
  assert.match(stdout, /验证一下禅道连接/);
});

test('安装脚本：已经在宿主技能目录里时跳过安装步骤', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin } = fakeHostBin(home);

  const installed = path.join(home, '.claude', 'skills', 'rh-product-feedback');
  fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SKILL_DIR, 'SKILL.md'), path.join(installed, 'SKILL.md'));
  fs.copyFileSync(path.join(SKILL_DIR, 'config.local.json'), path.join(installed, 'config.local.json'));
  fs.copyFileSync(INSTALL_SH, path.join(installed, 'scripts', 'install.sh'));

  const stdout = execFileSync('bash', [path.join(installed, 'scripts', 'install.sh'), '--skip-credentials'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.match(stdout, /技能已就位/);
});

test('安装脚本：没有本地技能目录时从仓库拉配置并用 skills CLI 装技能', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin, log } = fakeHostBin(home);

  // 假的 curl：把仓库里的接入配置复制到脚本要的位置
  const curl = path.join(bin, 'curl');
  fs.writeFileSync(
    curl,
    `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "${path.join(SKILL_DIR, 'config.local.json')}" "$out"
`,
    { mode: 0o755 },
  );

  // 假的 npx：模拟 skills CLI 装技能
  const npx = path.join(bin, 'npx');
  fs.writeFileSync(
    npx,
    `#!/usr/bin/env bash
echo "npx $*" >> "${log}"
target="$HOME/.claude/skills/rh-product-feedback"
mkdir -p "$target/scripts"
cp "${path.join(SKILL_DIR, 'SKILL.md')}" "$target/SKILL.md"
cp "${path.join(SKILL_DIR, 'config.local.json')}" "$target/config.local.json"
exit 0
`,
    { mode: 0o755 },
  );

  // 管道执行（cat | bash）：脚本拿不到自己的路径，走远程模式
  const stdout = execFileSync(
    'bash',
    ['-c', 'cat "$1" | bash -s -- "$2"', 'bash', INSTALL_SH, '--skip-credentials'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    },
  );

  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /npx --yes skills add /);
  assert.match(calls, /claude mcp add --transport http zentao /);
  assert.match(stdout, /技能已安装/);
});

test('安装脚本：子进程读 stdin 也不会把脚本本身吃掉（管道模式回归）', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin, log } = fakeHostBin(home);

  // 假的 npx：故意把 stdin 读干净，模拟会吞掉脚本内容的子进程
  const npx = path.join(bin, 'npx');
  fs.writeFileSync(npx, `#!/usr/bin/env bash\necho "npx $*" >> "${log}"\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });

  const stdout = execFileSync(
    'bash',
    ['-c', 'cat "$1" | bash -s -- "$2"', 'bash', INSTALL_SH, '--skip-credentials'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    },
  );

  assert.match(stdout, /装好了/, '脚本被提前吃掉了');
  assert.match(fs.readFileSync(log, 'utf8'), /claude mcp add --transport http zentao /);
});

test('安装脚本：跳过凭据时打印写入凭据的那条命令，供 Agent 原样转交用户', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin } = fakeHostBin(home);

  const stdout = execFileSync('bash', [INSTALL_SH, '--skip-credentials'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.match(stdout, /凭据：已跳过/);
  assert.match(stdout, /bash .*set-credentials\.sh/);
});

test('安装脚本：宿主在运行时加 --force 继续登记，并提示条目可能被宿主回写覆盖', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin, log } = fakeHostBin(home, { claudeRunning: true });

  const stdout = execFileSync('bash', [INSTALL_SH, '--skip-credentials', '--force'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.match(fs.readFileSync(log, 'utf8'), /claude mcp add --transport http zentao /);
  assert.match(stdout, /可能被宿主回写覆盖/);
});

test('安装脚本：宿主在运行且没有 --force 时停下，提示先退出宿主', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('rh-home-');
  const { bin, log } = fakeHostBin(home, { claudeRunning: true });

  assert.throws(
    () =>
      execFileSync('bash', [INSTALL_SH, '--skip-credentials'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      }),
    /Claude Code 正在运行/,
  );

  assert.doesNotMatch(
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    /mcp add/,
    '停下时不应登记 MCP',
  );
});
