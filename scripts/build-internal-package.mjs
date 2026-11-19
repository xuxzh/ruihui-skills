#!/usr/bin/env node
// 打包内网版技能包：把技能目录、接入配置与凭据脚本组装成一个顶层自洽的目录。
//
// 用法：
//   node scripts/build-internal-package.mjs                       # 用 .env 里的地址打包到 dist/
//   node scripts/build-internal-package.mjs --out <目录>
//   node scripts/build-internal-package.mjs --mcp-url <地址> --web-url <地址>
//
// 地址来源优先级：命令行参数 > 仓库根 .env > 技能目录里的 config.local.json。
// 产物目录是用户唯一要复制的东西：整个复制进通用技能目录即完成安装。
// 脚本不打印地址本身，避免内网地址留在终端记录里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'rh-product-feedback');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const PACKAGE_SCRIPTS = ['set-credentials.sh', 'set-credentials.ps1', 'zentao-client.mjs', 'zentao-query.mjs', 'zentao-query.sh', 'zentao-query.ps1', 'zentao-write.mjs', 'zentao-upload.mjs'];

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'dist'), mcpUrl: undefined, webUrl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (key === '--mcp-url') args.mcpUrl = argv[++i];
    else if (key === '--web-url') args.webUrl = argv[++i];
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`未知参数：${key}`);
  }
  return args;
}

/** 读取 .env 形式的 KEY=VALUE；只取需要的键，不做任何求值。 */
function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}

/** 禅道 Web 地址：从 OpenAPI 前缀里去掉 /api.php/v1，只留 Web 端根地址。 */
function toWebUrl(baseUrl) {
  return baseUrl.replace(/\/api\.php\/v1\/?$/, '').replace(/\/+$/, '');
}

function assertHttpUrl(value, label) {
  if (!value) throw new Error(`${label}为空：请在 .env 或命令行里提供内网地址`);
  if (!/^https?:\/\//.test(value)) throw new Error(`${label}不是 http(s) 地址`);
}

function resolveAddresses(args) {
  if (args.mcpUrl !== undefined) {
    assertHttpUrl(args.mcpUrl, '禅道 MCP 地址');
    const webUrl = args.webUrl ?? '';
    if (webUrl) assertHttpUrl(webUrl, '禅道 Web 地址');
    return { mcpUrl: args.mcpUrl, zentaoWebUrl: webUrl, source: '命令行参数' };
  }

  const env = readEnvFile(path.join(ROOT, '.env'));
  if (env.ZENTAO_MCP_URL) {
    const base = env.ZENTAO_BASE_URL ?? '';
    return {
      mcpUrl: env.ZENTAO_MCP_URL,
      zentaoWebUrl: args.webUrl ?? (base ? toWebUrl(base) : ''),
      source: '.env',
    };
  }

  const localConfig = path.join(SKILL_DIR, 'config.local.json');
  if (fs.existsSync(localConfig)) {
    const config = JSON.parse(fs.readFileSync(localConfig, 'utf8'));
    if (config.mcpUrl) {
      return {
        mcpUrl: config.mcpUrl,
        zentaoWebUrl: args.webUrl ?? config.zentaoWebUrl ?? '',
        source: '技能目录里的 config.local.json',
      };
    }
  }

  throw new Error(
    '找不到内网地址：请在仓库根 .env 填 ZENTAO_MCP_URL（可选 ZENTAO_BASE_URL），' +
      '或用 --mcp-url 传入，或先在技能目录放好 config.local.json',
  );
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * 随包默认产品：从技能目录里的 config.local.json 读，管理员预置后随包分发。
 * 没预置就是空位（id 为 null），技能会当没设默认产品处理。
 */
function readPackageDefaultProduct() {
  const localConfig = path.join(SKILL_DIR, 'config.local.json');
  if (!fs.existsSync(localConfig)) return { id: null, name: '' };
  try {
    const config = JSON.parse(fs.readFileSync(localConfig, 'utf8'));
    const preset = config.defaultProduct;
    if (preset && preset.id !== null && preset.id !== undefined && preset.id !== '') {
      return { id: Number(preset.id), name: String(preset.name || '') };
    }
  } catch {
    // 配置坏了就当没预置，不阻断打包
  }
  return { id: null, name: '' };
}

function buildPackage(args) {
  const { mcpUrl, zentaoWebUrl, source } = resolveAddresses(args);
  assertHttpUrl(mcpUrl, '禅道 MCP 地址');

  const out = args.out;
  const pkgDir = path.join(out, 'rh-product-feedback');
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  copyFile(path.join(SKILL_DIR, 'SKILL.md'), path.join(pkgDir, 'SKILL.md'));
  const refsDir = path.join(SKILL_DIR, 'references');
  for (const name of fs.readdirSync(refsDir)) {
    if (!name.endsWith('.md')) continue;
    copyFile(path.join(refsDir, name), path.join(pkgDir, 'references', name));
  }

  for (const name of PACKAGE_SCRIPTS) {
    const from = path.join(SCRIPTS_DIR, name);
    if (!fs.existsSync(from)) throw new Error(`缺少随包脚本：${name}`);
    const to = path.join(pkgDir, 'scripts', name);
    copyFile(from, to);
    if (name.endsWith('.sh')) fs.chmodSync(to, 0o755);
  }

  fs.writeFileSync(
    path.join(pkgDir, 'config.local.json'),
    `${JSON.stringify({ mcpUrl, zentaoWebUrl, defaultProduct: readPackageDefaultProduct() }, null, 2)}\n`,
  );

  return { pkgDir, source, hasWebUrl: Boolean(zentaoWebUrl) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      '用法：node scripts/build-internal-package.mjs [--out <目录>] [--mcp-url <地址>] [--web-url <地址>]\n',
    );
    return;
  }

  const { pkgDir, source, hasWebUrl } = buildPackage(args);

  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(pkgDir);

  process.stdout.write(`内网版技能包已生成：${pkgDir}\n`);
  process.stdout.write(`地址来源：${source}\n`);
  if (!hasWebUrl) process.stdout.write('提示：没有禅道 Web 地址，反馈链接会缺省\n');
  process.stdout.write('包含：\n');
  for (const file of files) process.stdout.write(`  ${file}\n`);
  process.stdout.write('\n下一步：把 rh-product-feedback 整个目录复制进宿主技能目录：\n');
  process.stdout.write('  macOS / Linux: mkdir -p ~/.agents/skills && cp -R <本目录>/rh-product-feedback ~/.agents/skills/\n');
  process.stdout.write('  Windows: Copy-Item -Recurse <本目录>\\rh-product-feedback "$env:USERPROFILE\\.agents\\skills\\"\n');
  process.stdout.write('  装完后在宿主里说「帮我装禅道 MCP」：它会按自己所在的宿主登记禅道 MCP，并给你一条写本人凭据的命令。\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`打包失败：${err.message}\n`);
  process.exit(1);
}
