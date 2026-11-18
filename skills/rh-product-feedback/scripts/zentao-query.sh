#!/usr/bin/env bash
# 禅道只读查询器的 shell 包装：定位随包的 zentao-query.mjs 并用 node 跑它。
# 用法：bash zentao-query.sh products --match 报表
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18+ 才能跑禅道查询器（当前环境找不到 node）" >&2
  exit 127
fi

exec node "$here/zentao-query.mjs" "$@"
