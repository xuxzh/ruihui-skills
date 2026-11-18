#!/usr/bin/env bash
# 写入本机禅道接入凭据：交互式输入，密码不回显，落到只有本人可读的文件里。
#
# 用法：
#   bash set-credentials.sh          # 交互输入账号与密码
#   bash set-credentials.sh --token  # 交互输入账号与令牌（禅道 个人 → 令牌）
#   bash set-credentials.sh --path   # 只打印凭据文件位置
#
# 凭据文件（macOS / Linux）：~/.config/rh-zentao/credentials
#   内容两行：ZENTAO_ACCOUNT=<账号> / ZENTAO_PASSWORD=<密码>
#   用令牌时第二行是 ZENTAO_TOKEN=<令牌>
#
# 脚本不回显、不打印、不上传任何凭据内容，也不依赖当前工作目录。
# 用 bash 显式调用：macOS 默认 shell 是 zsh，zsh 的 read 不支持这套隐藏输入写法。
set -eu

mode="password"

while [ $# -gt 0 ]; do
  case "$1" in
    --token) mode="token"; shift ;;
    --path) mode="path"; shift ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

credentials_path() {
  printf '%s\n' "${HOME}/.config/rh-zentao/credentials"
}

main() {
  target=$(credentials_path)

  if [ "$mode" = "path" ]; then
    printf '%s\n' "$target"
    return 0
  fi

  if [ "$mode" = "token" ]; then
    key="ZENTAO_TOKEN"
    label="令牌"
  else
    key="ZENTAO_PASSWORD"
    label="密码"
  fi

  account=""
  secret=""
  if [ -t 0 ]; then
    printf '禅道账号: ' >&2
    IFS= read -r account || true
    printf '禅道%s（输入不回显）: ' "$label" >&2
    IFS= read -r -s secret || true
    printf '\n' >&2
  else
    IFS= read -r account || true
    IFS= read -r secret || true
  fi

  if [ -z "$account" ]; then
    printf '账号为空，未写入。\n' >&2
    exit 1
  fi
  if [ -z "$secret" ]; then
    printf '%s为空，未写入。\n' "$label" >&2
    exit 1
  fi

  dir=$(dirname "$target")
  umask 077
  mkdir -p "$dir"
  chmod 700 "$dir"
  printf 'ZENTAO_ACCOUNT=%s\n%s=%s\n' "$account" "$key" "$secret" > "$target"
  chmod 600 "$target"

  printf '已写入 %s\n' "$target"
}

main
