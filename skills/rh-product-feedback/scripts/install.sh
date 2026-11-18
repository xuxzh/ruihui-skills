#!/usr/bin/env bash
# 一次装好禅道反馈助手：装技能 → 登记禅道 MCP → 写入本人禅道凭据 → 提示重启与验证。
#
# 用法：
#   bash install.sh                     # 装技能 + 登记禅道 MCP + 交互输入账号与密码
#   bash install.sh --skip-credentials  # 跳过凭据（批量部署时由本人之后补）
#   bash install.sh --repo owner/name   # 远程安装时的仓库（默认 xuxzh/ruihui-skills）
#   bash install.sh --force             # Claude Code 正在运行也继续登记
#
# 三种起跑位置都能用：
#   1. 已装好的技能目录（~/.claude/skills/rh-product-feedback/scripts/）：技能已在位，只做配置
#   2. 下载的技能包（.../rh-product-feedback/scripts/）：就地复制到宿主技能目录
#   3. 管道或单独下载（curl ... | bash）：从仓库拉接入配置，用 skills CLI 装技能
#
# 脚本不回显禅道地址，也不回显凭据。
# 用 bash 显式调用：macOS 默认 shell 是 zsh。
set -eu

SKILL_NAME="rh-product-feedback"
DEFAULT_REPO="xuxzh/ruihui-skills"
REPO="$DEFAULT_REPO"
SKIP_CREDENTIALS=0
FORCE=0
WORKDIR=""

cleanup() {
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

note() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" 2>/dev/null || true
  printf '\n用法：bash install.sh [--skip-credentials] [--repo owner/name] [--force]\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-credentials) SKIP_CREDENTIALS=1; shift ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --repo=*) REPO="${1#--repo=}"; shift ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -n "$REPO" ] || die "--repo 不能为空"

raw_base="https://raw.githubusercontent.com/$REPO/main/skills/$SKILL_NAME"

# --- 定位自己与技能目录 -------------------------------------------------
self=${BASH_SOURCE[0]:-$0}
script_dir=""
if [ -f "$self" ]; then
  script_dir=$(cd "$(dirname "$self")" && pwd)
fi

skill_dir=""
if [ -n "$script_dir" ] && [ -f "$script_dir/../config.local.json" ]; then
  skill_dir=$(cd "$script_dir/.." && pwd)
fi

# --- 接入配置（禅道地址） ------------------------------------------------
config_file=""
if [ -n "$skill_dir" ]; then
  config_file="$skill_dir/config.local.json"
else
  WORKDIR=$(mktemp -d)
  config_file="$WORKDIR/config.local.json"
  command -v curl >/dev/null 2>&1 || die "没有 curl：改用下载技能包后运行本脚本"
  curl -fsSL "$raw_base/config.local.json" -o "$config_file" ||
    die "拉取接入配置失败：检查网络，或下载技能包后运行本脚本"
fi

mcp_url=$(sed -n 's/.*"mcpUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$config_file" | head -1)
[ -n "$mcp_url" ] || die "接入配置里没有 mcpUrl：技能包可能不完整，重新装一次"

# --- 宿主 ----------------------------------------------------------------
host_installed() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ] ;;
    pi) command -v pi >/dev/null 2>&1 || [ -d "$HOME/.agents" ] || [ -d "$HOME/.pi" ] ;;
  esac
}

host_skill_dir() {
  case "$1" in
    claude) printf '%s\n' "$HOME/.claude/skills" ;;
    pi) printf '%s\n' "$HOME/.agents/skills" ;;
  esac
}

host_running() {
  case "$1" in
    claude) pgrep -f '(^|[/[:space:]])claude([[:space:]]|$)' >/dev/null 2>&1 ;;
    pi) pgrep -f '(^|[/[:space:]])pi([[:space:]]|$)' >/dev/null 2>&1 ;;
  esac
}

hosts=""
for host in claude pi; do
  if host_installed "$host"; then
    hosts="$hosts $host"
  fi
done
[ -n "$hosts" ] || die "没有检测到 Claude Code 或 pi：先装好其中一个宿主再运行本脚本"

# --- 装技能 --------------------------------------------------------------
skill_ready=0
if [ -n "$script_dir" ]; then
  parent=$(cd "$script_dir/.." && pwd)
  grandparent=$(cd "$parent/.." && pwd)
  for host in $hosts; do
    if [ "$grandparent" = "$(host_skill_dir "$host")" ]; then
      skill_ready=1
    fi
  done
fi

if [ "$skill_ready" -eq 1 ]; then
  note "技能已就位：$script_dir/.."
elif [ -n "$skill_dir" ]; then
  for host in $hosts; do
    target="$(host_skill_dir "$host")/$SKILL_NAME"
    mkdir -p "$(dirname "$target")"
    rm -rf "$target.new"
    cp -R "$skill_dir" "$target.new"
    rm -rf "$target"
    mv "$target.new" "$target"
    note "技能已安装：$target"
  done
else
  command -v npx >/dev/null 2>&1 || die "没有 npx：改用下载技能包后运行本脚本"
  note "正在用 skills CLI 安装技能…"
  npx --yes skills add "$REPO" --skill "$SKILL_NAME" --global --yes >/dev/null ||
    die "技能安装失败：检查网络后重试"
  note "技能已安装（${REPO}）"
fi

# --- 登记禅道 MCP -------------------------------------------------------
register_claude() {
  current=$(claude mcp get zentao 2>/dev/null || true)
  if printf '%s' "$current" | grep -qF "$mcp_url"; then
    note "Claude Code：禅道 MCP 已是最新，跳过登记"
    return 0
  fi
  if [ -n "$current" ]; then
    note "Claude Code：已有 zentao 条目但地址与技能包不一致——在 Agent 里说「更新禅道地址」，它只改这一个键"
    return 0
  fi
  claude mcp add --transport http zentao "$mcp_url" --scope user >/dev/null ||
    die "Claude Code：登记禅道 MCP 失败"
  note "Claude Code：已登记禅道 MCP（地址不回显）"
}

register_pi() {
  current=$(pi mcp list 2>/dev/null || true)
  if printf '%s' "$current" | grep -qF "$mcp_url"; then
    note "pi：禅道 MCP 已是最新，跳过登记"
    return 0
  fi
  if printf '%s' "$current" | grep -q 'zentao'; then
    note "pi：已有 zentao 条目但地址与技能包不一致——在 Agent 里说「更新禅道地址」，它只改这一个键"
    return 0
  fi
  pi mcp add zentao --url "$mcp_url" >/dev/null || die "pi：登记禅道 MCP 失败"
  note "pi：已登记禅道 MCP（地址不回显）"
}

for host in $hosts; do
  if [ "$host" = "claude" ] && [ "$FORCE" -eq 0 ] && host_running claude; then
    die "Claude Code 正在运行：运行中的 Claude Code 会回写 ~/.claude.json，登记好的条目可能丢失。
先退出 Claude Code 再跑这条命令（确实要继续就加 --force）。"
  fi
  if [ "$host" = "claude" ]; then
    register_claude
  else
    register_pi
  fi
done

# --- 写入本人凭据 -------------------------------------------------------
if [ "$SKIP_CREDENTIALS" -eq 1 ]; then
  note "凭据：已跳过（本人之后自己写）"
else
  cred_script=""
  if [ -n "$script_dir" ] && [ -f "$script_dir/set-credentials.sh" ]; then
    cred_script="$script_dir/set-credentials.sh"
  else
    WORKDIR="${WORKDIR:-$(mktemp -d)}"
    cred_script="$WORKDIR/set-credentials.sh"
    curl -fsSL "$raw_base/scripts/set-credentials.sh" -o "$cred_script" ||
      die "拉取凭据脚本失败：检查网络，或下载技能包后运行本脚本"
  fi
  note "接下来输入你自己的禅道账号和密码（密码不回显，只写在你自己的机器上）"
  bash "$cred_script"
fi

# --- 收尾 ---------------------------------------------------------------
note ""
note "装好了。接下来："
note "  1. 重启你的 AI Agent：Claude Code 退出重开；pi 执行 /reload"
note "  2. 在 Agent 里说：验证一下禅道连接"
note "  3. 之后直接说：帮我提个 Bug"
