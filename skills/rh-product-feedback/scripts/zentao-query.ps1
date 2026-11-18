# 禅道只读查询器的 PowerShell 包装：定位随包的 zentao-query.mjs 并用 node 跑它。
# 用法：powershell -ExecutionPolicy Bypass -File zentao-query.ps1 products --match 报表
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'zentao-query.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error '需要 Node.js 18+ 才能跑禅道查询器（当前环境找不到 node）'
  exit 127
}

& node $script @args
exit $LASTEXITCODE
