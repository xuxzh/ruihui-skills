// 更新日志（CHANGELOG.md）的解析、Release 正文抽取与一致性检查。
// 用法：
//   node scripts/release-notes.mjs <version>                                 打印该版本的段落，作为 GitHub Release 正文
//   node scripts/release-notes.mjs --check <version> [--skill-file <path>]   只做一致性检查（发版工作流用），失败退出 1
// tests/validate-skills.mjs 复用这里的解析函数，避免两套解析。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const SKILL_PATH = path.join(ROOT, 'skills', 'rh-product-feedback', 'SKILL.md');
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
  console.error('用法：node scripts/release-notes.mjs <version> | --check <version> [--skill-file <path>]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
