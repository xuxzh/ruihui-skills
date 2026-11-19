#!/usr/bin/env node
// 查重助手（rh-product-feedback 随包脚本）：把一个标题切成关键词特征，生成「组内且、组间或」的变体组。
//
// 为什么有它：中文标题的语序常与用户口语不同——用户说「切换语言功能失效」，禅道里写的是
// 「语言切换功能失效」，整串包含会漏掉（ADR-0010 记过的坑）。按二元组切词后，两边的
// 特征仍有重叠，交叠的特征两两成组交给禅道 CLI 匹配，两种语序就都能命中。
//
// 边界：
//   - 只做切词与变体生成，不连禅道、不取数；取数与匹配在入口脚本 zentao.mjs 里做。
//   - 匹配语义与官方禅道 CLI 的 --search 一致：组内逗号=「且」，组与组之间=「或」，
//     匹配是大小写不敏感的子串包含；CLI 在客户端做匹配（服务端 filters 会被忽略）。
//   - 特征、匹配分与旧查询器 zentao-query.mjs 的实现一致（旧脚本随 #24 删除后由这里接手）。
//
// 用法：node zentao-dedupe.mjs --title "<标题>"，打印变体组（一行一组）。

import { pathToFileURL } from 'node:url';

// 匹配分门槛：查询特征被标题覆盖的比例低于它就不算重复（与旧查询器一致）
export const MATCH_THRESHOLD = 0.5;

// 两两配对时的组数上限：n 个特征两两配对是 n(n-1)/2 组，标题太长会撑爆命令行
const MAX_PAIR_GROUPS = 40;

/**
 * 关键词特征：中文取二元组，英文按词——中文标题语序常与用户口语不同，二元组重叠更稳。
 * 返回的顺序是出现顺序，变体组按这个顺序生成，便于人读。
 */
export function features(text) {
  const set = new Set();
  const norm = String(text || '').toLowerCase();
  const chunks = norm.split(/[\s,，。、；;：:!！?？/\\()（）\[\]{}"'`~·—–_\-]+/u).filter(Boolean);
  for (const chunk of chunks) {
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      if (chunk.length === 1) set.add(chunk);
      for (let i = 0; i + 1 < chunk.length; i++) set.add(chunk.slice(i, i + 2));
    } else {
      set.add(chunk);
    }
  }
  return set;
}

/**
 * 关键词变体组：每组是若干特征的合取（组内=且），多组之间是析取（组间=或）。
 *
 * 两两配对：只要标题与查询至少共有 2 个特征，就一定有一组两两都在标题里 → 一定能命中；
 * 共有 1 个特征本来也不该算重复（与旧查询器 matchScore 的门槛一致）。
 * 特征太多时改用相邻窗口（相邻二元组 + 长度为 3 的滑动窗口），组数线性增长——
 * 代价是共有的特征若在查询里隔得远就可能漏掉，所以只在组数会失控时才退让。
 */
export function variantGroups(title) {
  const list = [...features(title)];
  if (!list.length) return [];
  if (list.length === 1) return [list[0]];

  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) pairs.push(`${list[i]},${list[j]}`);
  }
  if (pairs.length <= MAX_PAIR_GROUPS) return pairs;

  const windows = [];
  for (let i = 0; i + 1 < list.length; i++) windows.push(`${list[i]},${list[i + 1]}`);
  for (let i = 0; i + 2 < list.length; i++) windows.push(`${list[i]},${list[i + 1]},${list[i + 2]}`);
  return windows;
}

/** 查询词被标题覆盖的比例（0~1）。 */
export function matchScore(query, title) {
  const q = String(query || '').trim();
  const t = String(title || '').toLowerCase();
  if (!q) return 1;
  const normQ = q.toLowerCase().replace(/\s+/g, '');
  const normT = t.replace(/\s+/g, '');
  if (normT.includes(normQ)) return 1;
  const a = features(q);
  const b = features(t);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const feature of a) if (b.has(feature)) inter++;
  if (inter < 2 && a.size > 1) return 0;
  return inter / a.size;
}

/** 按匹配分排序：低于门槛的丢掉，同分保持原顺序。 */
export function rankByMatch(query, items, pickTitle, limit) {
  if (!query) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: matchScore(query, pickTitle(item)) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------- 单独跑

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[arg.slice(2)] = next;
      i++;
    } else {
      opts[arg.slice(2)] = true;
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const title = String(opts.title ?? '').trim();
  if (!title) {
    process.stderr.write('错误：用法：node zentao-dedupe.mjs --title "<标题>"\n');
    process.exit(2);
  }
  const list = [...features(title)];
  const groups = variantGroups(title);
  process.stdout.write(`# 查重变体（查询：${title}）\n`);
  process.stdout.write(`# 特征（中文二元组 + 英文按词）：${list.join(' ')}\n`);
  process.stdout.write(`# 组内逗号=且，组与组之间=或；共 ${groups.length} 组\n`);
  for (const group of groups) process.stdout.write(`${group}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
