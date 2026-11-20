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
  check(`${dirName}: SKILL.md 正文 ≤220 行`, body.split('\n').length <= 220, `${body.split('\n').length} 行`);

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
  // 版本号与通道标记：给 Agent 判「是不是旧版」用（业务用户看不到这些）。
  const meta = parsed.data.metadata || {};
  check('rh-product-feedback: 版本号是 0.13.0', meta['rh-version'] === '0.13.0', meta['rh-version']);
  check('rh-product-feedback: 标记当前接入通道是 cli', meta['rh-channel'] === 'cli', meta['rh-channel']);
  check('rh-product-feedback: 不再标记 MCP 通道', !('rh-mcp-server' in meta));

  const all = `${parsed.body}\n` + fs.readdirSync(path.join(SKILLS_DIR, 'rh-product-feedback', 'references'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(SKILLS_DIR, 'rh-product-feedback', 'references', f), 'utf8'))
    .join('\n');
  const rules = [
    ['写入参数必须包在 payload 内', /payload/],
    ['写入后必须回读校验', /回读/],
    ['写入前需要用户确认', /确认/],
    ['结果不确定时先查核实、不重复创建', /不重复创建|先查后报|不盲目重试/],
    ['禅道账号的身份边界', /禅道账号/],
    ['接入凭据由用户本机写入', /接入凭据/],
    ['未注册时指向引导安装', /references\/setup\.md/],
    ['附件上传不可用的说明', /附件/],
    ['反馈类型映射 bug/story/advice', /`bug`/],
    ['需求类型映射 story', /`story`/],
    ['建议类型映射 advice', /`advice`/],
    ['查重降级方案（分页 + 客户端匹配）', /客户端匹配|分页/],
    ['事实 / 推断 / 无法确定三段式', /推断/],
    ['技能触发的安装入口', /\/rh-product-feedback install/],
    ['凭据必须由本人写入、Agent 不代劳', /凭据必须由本人/],
    ['交付时给出禅道直达链接', /feedback-view-/],
    ['链接地址取自 config.local.json 的 zentaoWebUrl', /zentaoWebUrl/],
    ['列表与详情读取走随包入口脚本', /zentao\.mjs/],
    ['原始 JSON 不进上下文', /原始 JSON/],
    ['不用调小页大小绕开截断', /--page-size/],
    ['地址核对按需触发', /按需触发/],
    ['随包入口脚本在 setup.md 里有说明', /随包入口脚本/],
  ];
  for (const [label, re] of rules) check(`rh-product-feedback: ${label}`, re.test(all));

  for (const script of ['zentao.mjs', 'zentao-dedupe.mjs', 'connect.mjs', 'set-credentials.sh', 'set-credentials.ps1']) {
    check(`rh-product-feedback: scripts/${script} 存在`, fs.existsSync(path.join(SKILLS_DIR, 'rh-product-feedback', 'scripts', script)));
  }

  const refs = ['feedback-templates.md', 'zentao-cli.md', 'workflow.md', 'error-handling.md', 'setup.md'];
  for (const ref of refs) {
    check(`rh-product-feedback: SKILL.md 引用 references/${ref}`, parsed.body.includes(`references/${ref}`));
  }

  // 渐进披露：references/ 下每个 .md 都必须被 SKILL.md 指向，否则就是建了没人读的死文件。
  const refDir = path.join(SKILLS_DIR, 'rh-product-feedback', 'references');
  for (const file of fs.readdirSync(refDir).filter((f) => f.endsWith('.md'))) {
    check(`rh-product-feedback: references/${file} 被 SKILL.md 指向`, parsed.body.includes(`references/${file}`));
  }
}

// ---- 3. 文档与技能一致 -------------------------------------------------
console.log('\n[3] 文档与技能一致');
const quickStart = path.join(ROOT, 'docs', 'quick-start.md');
if (fs.existsSync(quickStart)) {
  const quickText = fs.readFileSync(quickStart, 'utf8');
  check('快速上手写了粘贴给当前 Agent 的安装提示词', quickText.includes('npx skills add xuxzh/ruihui-skills'));
  check('快速上手写了本机写入页面的命令', quickText.includes('connect.mjs'));
  check('快速上手保留了终端兜底的凭据脚本', quickText.includes('set-credentials.sh'));
  check('快速上手不再让用户跑安装脚本', !quickText.includes('install.sh'));

  // 速查段必须自足：业务用户只看这一段就能装好并提第一条单（ADR-0014）。
  const quickLines = quickText.split('\n');
  const quickStartAt = quickLines.findIndex((l) => /^## 三步速查\s*$/.test(l));
  check('快速上手有「三步速查」段', quickStartAt >= 0);
  if (quickStartAt >= 0) {
    let quickEnd = quickLines.length;
    for (let i = quickStartAt + 1; i < quickLines.length; i++) {
      if (/^## /.test(quickLines[i])) {
        quickEnd = i;
        break;
      }
    }
    const seg = quickLines.slice(quickStartAt, quickEnd);
    while (seg.length && !seg[seg.length - 1].trim()) seg.pop();
    check('三步速查 ≤ 40 行', seg.length <= 40, `${seg.length} 行`);

    // 内容块 = 围栏代码块 / 引用块 / 列表块，各算一块。
    let blocks = 0;
    let inFence = false;
    let inQuote = false;
    let inList = false;
    for (const raw of seg) {
      const line = raw.trim();
      if (line.startsWith('```')) {
        if (inFence) {
          inFence = false;
          blocks++;
        } else {
          inFence = true;
          inQuote = false;
          inList = false;
        }
        continue;
      }
      if (inFence) continue;
      if (line.startsWith('> ')) {
        if (!inQuote) {
          inQuote = true;
          inList = false;
          blocks++;
        }
        continue;
      }
      inQuote = false;
      if (/^([-*]|\d+\.)\s/.test(line)) {
        if (!inList) {
          inList = true;
          blocks++;
        }
        continue;
      }
      inList = false;
    }
    check('三步速查 ≤ 5 个内容块', blocks <= 5, `${blocks} 块`);

    const segText = seg.join('\n');
    for (const [label, needle] of [
      ['写凭据的本机页面', 'connect.mjs'],
      ['让 Agent 验证连接的话术', '验证一下禅道连接'],
      ['提单的示例句', '帮我提个 Bug'],
      ['提交人不是本人的提示', '提交人'],
    ]) {
      check(`三步速查里写了${label}`, segText.includes(needle));
    }
  }

  // 安装 / 重装提示词只有一份真相：quick-start 与随包 setup.md 逐字一致（ADR-0014）。
  const setupPath = path.join(SKILLS_DIR, 'rh-product-feedback', 'references', 'setup.md');
  if (fs.existsSync(setupPath)) {
    const setupText = fs.readFileSync(setupPath, 'utf8');
    const promptOf = (text) => {
      const m = text.match(/```\n(帮我把 ruihui 的产品反馈助手[\s\S]*?)```/);
      return m ? m[1] : '';
    };
    const inQuickStart = promptOf(quickText);
    const inSetup = promptOf(setupText);
    check(
      '安装 / 重装提示词与随包 setup.md 逐字一致',
      !!inQuickStart && inQuickStart === inSetup,
      !inQuickStart || !inSetup ? '找不到提示词块' : inQuickStart === inSetup ? '' : '两处不一致',
    );

    // 提示词必须自带来源：没有来源时，Agent 只会去市场里搜，搜不到就误以为是私有源。
    check(
      '安装 / 重装提示词写明来源地址与安装命令',
      inQuickStart.includes('https://github.com/xuxzh/ruihui-skills') &&
        inQuickStart.includes('npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global'),
    );

    // 首装与重装用同一段提示词：两个文件里都只能出现一份，不能各写一份然后走样。
    for (const [label, text] of [['快速上手', quickText], ['随包 setup.md', setupText]]) {
      const count = (text.match(/帮我把 ruihui 的产品反馈助手/g) || []).length;
      check(`${label}里的安装 / 重装提示词只有一份`, count === 1, `${count} 份`);
    }
    check(
      '快速上手没有另写一段更新提示词',
      !/帮我更新 ruihui 的产品反馈助手/.test(quickText),
    );

    check(
      '快速上手写了检查与更新命令',
      quickText.includes('npx skills check') && quickText.includes('npx skills update rh-product-feedback'),
    );
    check('快速上手说明重装不用重做接入', quickText.includes('不用重做接入'));
    check('快速上手的重装小节指向同一段提示词', quickText.includes('把上面那段提示词原样再发一次'));

    // 业务用户不看版本差异：面向用户的文档里不出现通道术语。
    check('快速上手不出现 MCP 术语', !/\bMCP\b/.test(quickText));
    check('快速上手不出现「禅道 CLI」这类说法', !/禅道\s*CLI|官方\s*CLI/.test(quickText));

    // 重装路径必须写在随包文档里：Agent 靠它自己判版本、自己清理。
    for (const [label, needle] of [
      ['有重装 / 更新小节', '## 重装 / 更新'],
      ['自己判版本（旧版判据）', 'zentao-query.mjs'],
      ['清掉旧通道残留', 'zentao-write.mjs'],
      ['复用本机凭据', '~/.config/rh-zentao/credentials'],
      ['删掉旧登记', 'mcp remove zentao'],
      ['重载宿主', '/reload'],
      ['只读自检', 'zentao.mjs products'],
      ['不问终端用户是哪一版', '不要问终端用户'],
    ]) {
      check(`随包 setup.md 写了${label}`, setupText.includes(needle));
    }

    // Node.js 兜底：本机没有 Node.js 时由 Agent 装，优先用机器上已有的版本管理器。
    for (const [label, needle] of [
      ['先确认 Node.js 版本', 'node --version'],
      ['优先用已有的版本管理器', 'fnm'],
      ['没有版本管理器时装官方的', 'winget install OpenJS.NodeJS.LTS'],
      ['不动已有的旧 node', '不要动它'],
      ['凭据走本机写入页面', 'connect.mjs'],
      ['终端兜底的凭据脚本', 'set-credentials.sh'],
      ['装完要重开宿主', '重开'],
      ['装不上的兜底是网页端', '禅道网页端'],
    ]) {
      check(`随包 setup.md 写了${label}`, setupText.includes(needle));
    }
    check('安装 / 重装提示词要求先确认 Node.js', inQuickStart.includes('Node.js 18'));
  }
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
// 随包默认产品预置在接入配置里：字段必须在，否则技能读不到预置值。
const skillConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/rh-product-feedback/config.local.json'), 'utf8'));
check(
  '接入配置预留随包默认产品字段',
  skillConfig && Object.prototype.hasOwnProperty.call(skillConfig, 'defaultProduct'),
  '缺 defaultProduct 字段',
);
// 技能文档必须写清两层的边界：随包默认只读、本机默认不进包。
const skillMd = fs.readFileSync(path.join(ROOT, 'skills/rh-product-feedback/SKILL.md'), 'utf8');
check('SKILL.md 写明随包默认产品与本机默认产品的边界', /随包默认/.test(skillMd) && /preferences\.json|偏好文件/.test(skillMd));

// ---- 汇总 --------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
