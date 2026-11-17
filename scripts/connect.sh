#!/usr/bin/env bash
# 登记禅道 MCP：地址从技能包内的 config.local.json 读取，脚本不打印地址。
#
# 用法：
#   bash connect.sh              # 登记到 Claude Code（主宿主）
#   bash connect.sh --host pi    # 登记到 pi（次宿主）
#
# 这是「Agent 无法改宿主配置」时的降级路径，也是实施人员批量部署用的命令。
# 用 bash 显式调用：macOS 默认 shell 是 zsh。
set -eu

pkg_dir=$(cd "$(dirname "$0")/.." && pwd)
config="$pkg_dir/config.local.json"

host="claude"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2:-}"; shift 2 ;;
    --host=*) host="${1#--host=}"; shift ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$config" ]; then
  printf '找不到 %s：这是不含内网配置的公开版技能包，请找管理员拿内网版。\n' "$config" >&2
  exit 1
fi

mcp_url=$(sed -n 's/.*"mcpUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$config" | head -1)
if [ -z "$mcp_url" ]; then
  printf 'config.local.json 里没有 mcpUrl，请找管理员重新打包。\n' >&2
  exit 1
fi

case "$host" in
  claude)
    if ! command -v claude >/dev/null 2>&1; then
      printf '没有找到 claude 命令，请先安装 Claude Code。\n' >&2
      exit 1
    fi
    existing=$(claude mcp get zentao 2>/dev/null || true)
    if [ -n "$existing" ]; then
      printf 'zentao 已经登记过了。\n'
      printf '如果地址变了，先移除再重跑本脚本：claude mcp remove zentao --scope user\n'
      printf '（移除会丢掉这个条目上的其他配置，例如将来加的请求头令牌。）\n'
      exit 0
    fi
    claude mcp add --transport http zentao "$mcp_url" --scope user >/dev/null
    printf '已登记 zentao（地址不回显）。现在打开 Claude Code，在对话里说「帮我连上禅道」。\n'
    ;;
  pi)
    if ! command -v pi >/dev/null 2>&1; then
      printf '没有找到 pi 命令，请先安装 pi。\n' >&2
      exit 1
    fi
    pi mcp add zentao --url "$mcp_url" >/dev/null
    printf '已登记 zentao（地址不回显）。在 pi 里执行 /reload 后，在对话里说「帮我连上禅道」。\n'
    ;;
  *)
    printf '未知宿主：%s（可选 claude / pi）\n' "$host" >&2
    exit 1
    ;;
esac
