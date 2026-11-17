# 登记禅道 MCP：地址从技能包内的 config.local.json 读取，脚本不打印地址。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File connect.ps1
#   powershell -ExecutionPolicy Bypass -File connect.ps1 -Host pi
#
# 这是「Agent 无法改宿主配置」时的降级路径，也是实施人员批量部署用的命令。
param([string]$Host = 'claude')

$ErrorActionPreference = 'Stop'

$pkgDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$configPath = Join-Path $pkgDir 'config.local.json'

if (-not (Test-Path $configPath)) {
  Write-Error "找不到 $configPath ：这是不含内网配置的公开版技能包，请找管理员拿内网版。"
  exit 1
}

$config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
if (-not $config.mcpUrl) {
  Write-Error 'config.local.json 里没有 mcpUrl，请找管理员重新打包。'
  exit 1
}

switch ($Host) {
  'claude' {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
      Write-Error '没有找到 claude 命令，请先安装 Claude Code。'
      exit 1
    }
    $existing = & claude mcp get zentao 2>$null
    if ($existing) {
      Write-Output 'zentao 已经登记过了。'
      Write-Output '如果地址变了，先移除再重跑本脚本：claude mcp remove zentao --scope user'
      Write-Output '（移除会丢掉这个条目上的其他配置，例如将来加的请求头令牌。）'
      exit 0
    }
    & claude mcp add --transport http zentao $config.mcpUrl --scope user | Out-Null
    Write-Output '已登记 zentao（地址不回显）。现在打开 Claude Code，在对话里说「帮我连上禅道」。'
  }
  'pi' {
    if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
      Write-Error '没有找到 pi 命令，请先安装 pi。'
      exit 1
    }
    & pi mcp add zentao --url $config.mcpUrl | Out-Null
    Write-Output '已登记 zentao（地址不回显）。在 pi 里执行 /reload 后，在对话里说「帮我连上禅道」。'
  }
  default {
    Write-Error "未知宿主：$Host（可选 claude / pi）"
    exit 1
  }
}
