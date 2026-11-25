// 运行：node --test tests/release-notes.mjs
//
// 发版链路的静态约束：更新日志的解析与 Release 正文抽取、发版草稿的分组与版本号建议。
// 标签提交里的 rh-version、CHANGELOG.md 段落与 README 三处靠 tests/validate-skills.mjs 对齐；
// 这里守住 scripts/release-notes.mjs 自己的逻辑，草稿一旦漏提交或分错组，发版人就得重读整段历史。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  checkRelease,
  collectCommits,
  draftFromCommits,
  parseChangelog,
  parseSubject,
  releaseNotes,
  releasedSections,
  suggestVersion,
} from '../scripts/release-notes.mjs';

const ROOT = import.meta.dirname + '/..';
const FIXTURE = `# 更新日志

## [Unreleased]

## [0.14.0] - 2026-11-25

**升级须做**：重载宿主。

### 新增

- 放开流转（[ADR-0024](docs/adr/0024-x.md)），见[对比](https://example.com/compare)

[Unreleased]: https://github.com/xuxzh/ruihui-skills/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/xuxzh/ruihui-skills/compare/v0.13.0...v0.14.0
`;

test('解析：段落、日期与底部链接分开，Unreleased 也是一段', () => {
  const { sections, links } = parseChangelog(FIXTURE);
  assert.deepEqual(sections.map((s) => s.version), ['Unreleased', '0.14.0']);
  assert.equal(sections[1].date, '2026-11-25');
  assert.ok(sections[1].body.startsWith('**升级须做**'));
  assert.equal(links['0.14.0'], 'https://github.com/xuxzh/ruihui-skills/compare/v0.13.0...v0.14.0');
  assert.deepEqual(releasedSections(sections).map((s) => s.version), ['0.14.0']);
});

test('Release 正文：相对链接改指到标签提交，绝对链接原样保留', () => {
  const notes = releaseNotes(FIXTURE, '0.14.0');
  assert.ok(notes.includes('](https://github.com/xuxzh/ruihui-skills/blob/v0.14.0/docs/adr/0024-x.md)'));
  assert.ok(notes.includes('](https://example.com/compare)'));
  assert.equal(releaseNotes(FIXTURE, '0.13.0'), null);
});

test('发版检查：版本号不一致、缺段落、标签格式不对都会报出来', () => {
  assert.deepEqual(checkRelease(FIXTURE, '0.14.0', '0.14.0'), []);
  assert.equal(checkRelease(FIXTURE, '0.14.0', '0.13.0').length, 1);
  assert.equal(checkRelease(FIXTURE, '0.99.0', '0.99.0').length, 1);
  assert.equal(checkRelease(FIXTURE, 'v0.14.0', 'v0.14.0').length, 2);
});

test('提交标题：拆出类型、作用域、不兼容标记与正文标题', () => {
  assert.deepEqual(parseSubject('feat(zentao-cli): 入口脚本支持批量操作'), { type: 'feat', breaking: false, summary: '入口脚本支持批量操作' });
  assert.deepEqual(parseSubject('refactor(skills)!: 换接入通道'), { type: 'refactor', breaking: true, summary: '换接入通道' });
  assert.deepEqual(parseSubject('fix: 回读兼容 CLI'), { type: 'fix', breaking: false, summary: '回读兼容 CLI' });
  assert.deepEqual(parseSubject('没有类型的标题'), { type: '', breaking: false, summary: '没有类型的标题' });
});

test('草稿：按类型分组，相同标题只留一条，空组不出标题', () => {
  const commits = [
    { subject: 'feat(skills): 新增批量操作' },
    { subject: 'docs(skills): 同步口径' },
    { subject: 'feat(skills): 新增批量操作' },
    { subject: 'fix(zentao-cli): 回读兼容 CLI 不返回 actions' },
    { subject: 'refactor(skills): 删除旧直连实现' },
  ];
  const draft = draftFromCommits(commits, { version: '0.15.0', date: '2026-11-26' });
  assert.equal(draft.split('\n')[0], '## [0.15.0] - 2026-11-26');
  assert.equal(draft.match(/^- 新增批量操作$/gm).length, 1);
  assert.deepEqual(draft.match(/^### .+$/gm), ['### 新增', '### 变更', '### 修复', '### 移除']);
  assert.ok(draft.indexOf('- 删除旧直连实现') > draft.indexOf('### 移除'));
  assert.ok(!draft.includes('revert'));
});

test('版本号建议：feat 升 minor，只修升 patch，不兼容变更在 1.0 后升 major', () => {
  assert.equal(suggestVersion('0.14.0', [{ subject: 'feat(skills): x' }]), '0.15.0');
  assert.equal(suggestVersion('0.14.0', [{ subject: 'fix(skills): x' }]), '0.14.1');
  assert.equal(suggestVersion('0.14.0', [{ subject: 'docs(skills): x' }]), '0.14.1');
  assert.equal(suggestVersion('0.14.0', [{ subject: 'feat(skills)!: x' }]), '0.15.0');
  assert.equal(suggestVersion('1.2.3', [{ subject: 'fix(skills): x', body: 'BREAKING CHANGE: 换参数' }]), '2.0.0');
});

const hasTag = (tag) => spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: ROOT }).status === 0;

test('草稿范围：只收改动技能目录的提交（用真实历史 v0.13.0..v0.14.0 验证）', { skip: !hasTag('v0.13.0') && '本地没有标签（CI 浅克隆）' }, () => {
  const subjects = collectCommits('v0.13.0', 'v0.14.0').map((c) => parseSubject(c.subject).summary);
  assert.ok(subjects.some((s) => s.includes('生命周期流转')), '改了入口脚本的提交要在草稿里');
  assert.ok(subjects.some((s) => s.includes('速查段改名')), '顺手改了随包文档的提交也要在');
  assert.ok(!subjects.some((s) => s.includes('提单话术点名技能')), '只改 quick-start 的提交不进草稿');
  assert.ok(!subjects.some((s) => s.includes('记录放开缺陷与反馈')), '只改 ADR 的提交不进草稿');
});
