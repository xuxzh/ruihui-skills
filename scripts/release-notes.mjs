// 更新日志（CHANGELOG.md）的解析、Release 正文抽取、一致性检查与发版草稿。
// 用法：
//   node scripts/release-notes.mjs <version>                                 打印该版本的段落，作为 GitHub Release 正文
//   node scripts/release-notes.mjs --check <version> [--skill-file <path>]   只做一致性检查（发版工作流用），失败退出 1
//   node scripts/release-notes.mjs --draft [version]                         按上个标签以来改动技能目录的提交出段落草稿（发版前改写）
// tests/validate-skills.mjs 复用这里的解析函数，避免两套解析。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const SKILL_PATH = path.join(ROOT, 'skills', 'rh-product-feedback', 'SKILL.md');
export const SKILL_DIR = 'skills/rh-product-feedback';
export const REPO = 'xuxzh/ruihui-skills';
export const SKILL_VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECTION_RE = /^## \[([^\]]+)\](?: - (\S+))? *$/;
const LINK_REF_RE = /^\[([^\]]+)\]: (\S+) *$/;

/** 把更新日志拆成段落（`## [版本] - 日期`）与底部的链接引用（`[版本]: 链接`）。 */
export function parseChangelog(text) {
  const sections = [];
  const links = {};
  let current = null;
  for (const line of text.split('\n')) {
    const ref = line.match(LINK_REF_RE);
    if (ref) {
      links[ref[1]] = ref[2];
      continue;
    }
    const head = line.match(SECTION_RE);
    if (head) {
      current = { version: head[1], date: head[2] || '', body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return { sections: sections.map((s) => ({ ...s, body: s.body.join('\n').trim() })), links };
}

/** SKILL.md frontmatter 里的技能版本（`metadata.rh-version`）。 */
export function readSkillVersion(skillText) {
  const m = skillText.match(/^\s*rh-version:\s*"?([^"\s]+)"?\s*$/m);
  return m ? m[1] : '';
}

export function releasedSections(sections) {
  return sections.filter((s) => s.version !== 'Unreleased');
}

/** 语义化版本比较：a 新于 b 返回正数，相同返回 0。 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 更新日志底部应有的链接：有上一个版本就对比，最早的那个版本指向自己的 Release。 */
export function expectedLink(version, prev) {
  return prev
    ? `https://github.com/${REPO}/compare/v${prev}...v${version}`
    : `https://github.com/${REPO}/releases/tag/v${version}`;
}

/** 某个版本的 Release 正文：段落原文，仓库相对链接改指到标签对应的提交（Release 页面上相对链接会断）。 */
export function releaseNotes(text, version) {
  const section = parseChangelog(text).sections.find((s) => s.version === version);
  if (!section) return null;
  return section.body.replace(/\]\(([^)\s]+)\)/g, (whole, target) => (
    /^(https?:\/\/|#|mailto:)/.test(target) ? whole : `](https://github.com/${REPO}/blob/v${version}/${target})`
  ));
}

/** 发版检查：标签版本、标签提交里的 rh-version、更新日志段落三者一致。返回问题列表，空数组即通过。 */
export function checkRelease(text, version, skillVersion) {
  const problems = [];
  if (!SKILL_VERSION_RE.test(version)) problems.push(`标签不是 vX.Y.Z 形式：${version}`);
  const section = parseChangelog(text).sections.find((s) => s.version === version);
  if (!section) {
    problems.push(`CHANGELOG.md 里没有 [${version}] 段落`);
    return problems;
  }
  if (!DATE_RE.test(section.date)) problems.push(`[${version}] 段落缺日期（应写成 ## [${version}] - YYYY-MM-DD）`);
  if (!section.body) problems.push(`[${version}] 段落是空的`);
  if (skillVersion !== version) problems.push(`标签提交里的 rh-version 是 ${skillVersion || '（缺失）'}，标签是 ${version}`);
  return problems;
}

// ---- 发版草稿 ---------------------------------------------------------------

/** 提交标题 → 类型、是否不兼容、去掉前缀后的标题；不符合 Conventional Commits 的标题按普通变更处理。 */
export function parseSubject(subject) {
  const m = subject.match(/^([a-z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
  if (!m) return { type: '', breaking: false, summary: subject.trim() };
  return { type: m[1], breaking: m[2] === '!', summary: m[3].trim() };
}

function groupOf({ type, summary }) {
  if (type === 'feat') return '新增';
  if (type === 'fix') return '修复';
  if (type === 'revert' || /删除|下线/.test(summary)) return '移除';
  return '变更';
}

/** 一个版本里该升哪一位：feat 或不兼容变更升 minor（1.0 之后的不兼容升 major），其余升 patch。 */
export function suggestVersion(latest, commits) {
  const [major, minor, patch] = latest.split('.').map(Number);
  const parsed = commits.map((c) => ({ ...parseSubject(c.subject), breakingBody: /^BREAKING[- ]CHANGE:/m.test(c.body || '') }));
  const breaking = parsed.some((p) => p.breaking || p.breakingBody);
  if (breaking && major > 0) return `${major + 1}.0.0`;
  if (breaking || parsed.some((p) => p.type === 'feat')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** 上个标签到 toRef 之间改动技能目录的提交（最新在前）。 */
export function collectCommits(fromRef, toRef = 'HEAD') {
  // 显式 -n：本机的命令代理会把不带条数的 git log 截到 50 条。
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=false', 'log', '-n', '1000', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', `${fromRef}..${toRef}`, '--', SKILL_DIR],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ''] = record.split('\x1f');
      return { hash, subject, body };
    });
}

/** 把提交变成段落草稿：feat → 新增，fix → 修复，revert 或标题含删除 / 下线 → 移除，其余 → 变更；相同标题只留最新一条。 */
export function draftFromCommits(commits, { version, date }) {
  const groups = { 新增: [], 变更: [], 修复: [], 移除: [] };
  const seen = new Set();
  for (const commit of commits) {
    const parsed = parseSubject(commit.subject);
    if (!parsed.summary || seen.has(parsed.summary)) continue;
    seen.add(parsed.summary);
    groups[groupOf(parsed)].push(parsed.summary);
  }
  const lines = [`## [${version}] - ${date}`, ''];
  for (const [name, items] of Object.entries(groups)) {
    if (!items.length) continue;
    lines.push(`### ${name}`, '', ...items.map((s) => `- ${s}`), '');
  }
  return lines.join('\n').trimEnd();
}

function draft(versionArg) {
  const latest = releasedSections(parseChangelog(fs.readFileSync(CHANGELOG_PATH, 'utf8')).sections)[0]?.version;
  if (!latest) {
    console.error('✗ CHANGELOG.md 里没有已发版段落，草稿不知道从哪个标签算起');
    process.exit(1);
  }
  const fromTag = `v${latest}`;
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${fromTag}`], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    console.error(`✗ 本地没有标签 ${fromTag}，先 git fetch --tags`);
    process.exit(1);
  }
  const commits = collectCommits(fromTag);
  if (!commits.length) {
    console.error(`✗ ${fromTag}..HEAD 没有改动技能目录的提交，没有可发版的内容`);
    process.exit(1);
  }
  const version = versionArg && !versionArg.startsWith('--') ? versionArg : suggestVersion(latest, commits);
  if (!SKILL_VERSION_RE.test(version)) {
    console.error(`✗ 版本号不是 X.Y.Z 形式：${version}`);
    process.exit(1);
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const kinds = [...new Set(commits.map((c) => parseSubject(c.subject).type || '（无类型）'))].join(', ');
  console.error(`草稿范围：${fromTag}..HEAD 改动 ${SKILL_DIR} 的 ${commits.length} 个提交（${kinds}）`);
  console.error(`版本号建议：${version}（feat 或不兼容变更升 minor，其余升 patch）`);
  console.error('发版前请改写草稿：一个提交一条改成「这版对使用有什么影响」的话并合并同类项；');
  console.error('需要业务用户或实施人员动手时，在段首加一行「**升级须做**：…」；再与 [Unreleased] 里平时记下的条目合并。');
  process.stdout.write(`${draftFromCommits(commits, { version, date })}\n`);
}

function main(argv) {
  const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const [mode, value] = argv;
  if (mode === '--check' && value) {
    const flagAt = argv.indexOf('--skill-file');
    const skillText = fs.readFileSync(flagAt === -1 ? SKILL_PATH : argv[flagAt + 1], 'utf8');
    const problems = checkRelease(text, value, readSkillVersion(skillText));
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) process.exit(1);
    console.log(`✓ ${value}：标签、版本号与更新日志一致`);
    return;
  }
  if (mode && SKILL_VERSION_RE.test(mode)) {
    const notes = releaseNotes(text, mode);
    if (!notes) {
      console.error(`✗ CHANGELOG.md 里没有 [${mode}] 段落`);
      process.exit(1);
    }
    process.stdout.write(`${notes}\n`);
    return;
  }
  if (mode === '--draft') {
    draft(value);
    return;
  }
  console.error('用法：node scripts/release-notes.mjs <version> | --check <version> [--skill-file <path>] | --draft [version]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
