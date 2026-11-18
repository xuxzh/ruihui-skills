// 静态校验：技能元数据、目录结构、引用链接、硬约束覆盖、敏感信息扫描。
// 运行：node tests/validate-skills.mjs
// 退出码 0 = 全部通过；1 = 有失败项。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- 极简 YAML frontmatter 解析（只支持本仓库用到的键） ----------------
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const data = {};
  let inMetadata = false;
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (indented) {
      if (!inMetadata) continue;
      const kv = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) data.metadata[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      continue;
    }
    inMetadata = false;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'metadata') {
      data.metadata = {};
      inMetadata = true;
      continue;
    }
    data[key] = value.replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2] };
}

// ---- 通用工具 ---------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.worktrees') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- 1. 技能元数据 ----------------------------------------------------
console.log('\n[1] 技能元数据（Agent Skills Specification）');
const skillDirs = fs.existsSync(SKILLS_DIR)
  ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

if (!skillDirs.length) check('存在 skills/ 目录且至少一个技能', false, '未找到 skills/');
const parsedSkills = new Map();

for (const dirName of skillDirs) {
  const skillFile = path.join(SKILLS_DIR, dirName, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    check(`${dirName}: 存在 SKILL.md`, false);
    continue;
  }
  const raw = fs.readFileSync(skillFile, 'utf8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    check(`${dirName}: frontmatter 可解析`, false);
    continue;
  }
  parsedSkills.set(dirName, parsed);
  const { data, body } = parsed;

  check(`${dirName}: name 存在且合法`, !!data.name && SKILL_NAME_RE.test(data.name) && data.name.length <= 64, data.name);
  check(`${dirName}: name 与目录名一致`, data.name === dirName, `${data.name} vs ${dirName}`);
  check(`${dirName}: description 存在且 ≤1024 字符`, !!data.description && data.description.length <= 1024, `${data.description?.length || 0} 字符`);
  check(`${dirName}: compatibility ≤500 字符`, data.compatibility === undefined || data.compatibility.length <= 500);
  const metaValues = Object.values(data.metadata || {});
  check(`${dirName}: metadata 的值均为字符串`, metaValues.every((v) => typeof v === 'string'));
  check(`${dirName}: SKILL.md 正文 ≤500 行`, body.split('\n').length <= 500, `${body.split('\n').length} 行`);

  // 引用链接可达
  const links = [...raw.matchAll(/\]\(([^)#][^)]*\.md)\)/g)].map((m) => m[1]);
  for (const link of links) {
    const target = path.resolve(path.dirname(skillFile), link);
    check(`${dirName}: 引用 ${link} 可达`, fs.existsSync(target));
  }
}

// ---- 2. 硬约束覆盖（rh-product-feedback） ------------------------------
console.log('\n[2] 硬约束覆盖（rh-product-feedback）');
const parsed = parsedSkills.get('rh-product-feedback');
if (!parsed) {
  check('rh-product-feedback 存在', false);
} else {
  const all = `${parsed.body}\n` + fs.readdirSync(path.join(SKILLS_DIR, 'rh-product-feedback', 'references'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(SKILLS_DIR, 'rh-product-feedback', 'references', f), 'utf8'))
    .join('\n');
  const rules = [
    ['写入参数必须包在 payload 内', /payload/],
    ['写入后必须回读校验', /回读/],
    ['写入前需要用户确认', /确认/],
    ['结果不确定时先查核实、不重复创建', /不重复创建|先查后报|不盲目重试/],
    ['当前登录账号的身份边界', /当前登录账号/],
    ['接入凭据由用户本机写入', /接入凭据/],
    ['未注册时指向引导安装', /references\/setup\.md/],
    ['附件上传不可用的说明', /附件/],
    ['反馈类型映射 bug/story/advice', /`bug`/],
    ['需求类型映射 story', /`story`/],
    ['建议类型映射 advice', /`advice`/],
    ['查重降级方案（分页 + 客户端匹配）', /客户端匹配|分页/],
    ['事实 / 推断 / 无法确定三段式', /推断/],
    ['技能触发的安装入口', /\/rh-product-feedback install/],
    ['Agent 代跑安装脚本时不代输凭据', /--skip-credentials/],
    ['交付时给出禅道直达链接', /feedback-view-/],
    ['链接地址取自 config.local.json 的 zentaoWebUrl', /zentaoWebUrl/],
  ];
  for (const [label, re] of rules) check(`rh-product-feedback: ${label}`, re.test(all));

  const refs = ['feedback-templates.md', 'zentao-mcp.md', 'workflow.md', 'error-handling.md', 'setup.md'];
  for (const ref of refs) {
    check(`rh-product-feedback: SKILL.md 引用 references/${ref}`, parsed.body.includes(`references/${ref}`));
  }
}

// ---- 3. 文档与技能一致 -------------------------------------------------
console.log('\n[3] 文档与技能一致');
const quickStart = path.join(ROOT, 'docs', 'quick-start.md');
if (fs.existsSync(quickStart)) {
  const quickText = fs.readFileSync(quickStart, 'utf8');
  check('快速上手写了技能触发的安装入口', quickText.includes('/rh-product-feedback install'));
  check('快速上手写了手动安装脚本作为备选', quickText.includes('install.sh'));
} else {
  check('存在 docs/quick-start.md', false);
}

// ---- 4. 敏感信息扫描 ---------------------------------------------------
console.log('\n[4] 敏感信息扫描（公开仓库）');
const tracked = walk(ROOT);
const textFiles = tracked.filter((f) => /\.(md|mjs|js|json|yml|yaml|txt|example)$/.test(f) && !f.includes(`${path.sep}.git${path.sep}`));

// 被 .gitignore 忽略的文件不进公开仓库（如 dist/、.env），不参与扫描。
function isIgnored(rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT });
  return r.status === 0;
}
const scannedFiles = textFiles.filter((f) => !isIgnored(path.relative(ROOT, f)));

const envFile = path.join(ROOT, '.env');
const secretValues = [];
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(\S+)\s*$/);
    if (m && /TOKEN|PASSWORD|SECRET|KEY|ACCOUNT/.test(m[1])) secretValues.push([m[1], m[2]]);
  }
}

const PLACEHOLDER = /^(?:\{\{.*\}\}|<.*>|\$\{.*\}|xxx+|\.\.\.|changeme|placeholder)$/i;

// 禅道地址随技能包分发，内网地址只允许出现在接入配置文件里；出现在别处即为泄露。
const ADDRESS_ALLOWED = /^skills\/[^/]+\/config\.local\.json$/;

const ADDRESS_PATTERNS = [
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/, '私网 IP（10.x）'],
  [/\b(?:192\.168\.\d{1,3}\.\d{1,3})\b/, '私网 IP（192.168.x）'],
  [/\b(?:172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/, '私网 IP（172.16-31.x）'],
  [/\bhttps?:\/\/[a-z0-9-]+\.(?:internal|local|lan|corp)\b/i, '内网域名'],
];

const SECRET_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/, 'Bearer token'],
  [/(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*["']([^"'\s]{6,})["']/i, '疑似硬编码凭据'],
];

const PATTERNS = [...ADDRESS_PATTERNS, ...SECRET_PATTERNS];

let leaks = 0;
for (const file of scannedFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const patterns = ADDRESS_ALLOWED.test(rel) ? SECRET_PATTERNS : PATTERNS;
  for (const [re, label] of patterns) {
    const m = content.match(re);
    if (!m) continue;
    const value = m[1] ?? m[0];
    if (PLACEHOLDER.test(String(value).trim())) continue; // 占位符不是凭据
    leaks++;
    console.log(` FAIL  ${rel} 命中${label}：${m[0].slice(0, 40)}`);
  }
  for (const [key, value] of secretValues) {
    if (value && value.length > 5 && content.includes(value)) {
      leaks++;
      console.log(` FAIL  ${rel} 含有 .env 中 ${key} 的真实值`);
    }
  }
}
check('未发现凭据 / 真实业务数据（内网地址只允许在 config.local.json）', leaks === 0, leaks ? `${leaks} 处命中` : '');

// .env 必须被忽略
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
check('.env 在 .gitignore 中', /^\s*\.env\s*$/m.test(gitignore));
// 地址随技能包分发：接入配置必须进版本库，否则装到的技能没有地址可用。
const configTracked = spawnSync('git', ['ls-files', '--error-unmatch', 'skills/rh-product-feedback/config.local.json'], { cwd: ROOT });
check('技能包内的 config.local.json 已纳入版本库', configTracked.status === 0);

// ---- 汇总 --------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
