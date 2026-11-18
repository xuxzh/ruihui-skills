# 一次装好禅道反馈助手：装技能 → 登记禅道 MCP → 写入本人禅道凭据 → 提示重启与验证。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipCredentials
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Repo owner/name
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Force
#
# 三种起跑位置都能用：
#   1. 已装好的技能目录（%USERPROFILE%\.claude\skills\rh-product-feedback\scripts\）：技能已在位，只做配置
#   2. 下载的技能包（...\rh-product-feedback\scripts\）：就地复制到宿主技能目录
#   3. 单独下载后运行：脚本从仓库拉接入配置，用 skills CLI 装技能
#
# 脚本不回显禅道地址，也不回显凭据。
param(
  [switch]$SkipCredentials,
  [string]$Repo = 'xuxzh/ruihui-skills',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$SkillName = 'rh-product-feedback'
$RawBase = "https://raw.githubusercontent.com/$Repo/main/skills/$SkillName"

function Write-Note([string]$Text) { Write-Output $Text }
function Fail([string]$Text) { Write-Error $Text; exit 1 }

# --- 定位自己与技能目录 -------------------------------------------------
$scriptDir = $PSScriptRoot
$skillDir = $null
if (Test-Path (Join-Path (Split-Path -Parent $scriptDir) 'config.local.json')) {
  $skillDir = Split-Path -Parent $scriptDir
}

# --- 接入配置（禅道地址） ------------------------------------------------
$configFile = $null
if ($skillDir) {
  $configFile = Join-Path $skillDir 'config.local.json'
} else {
  try {
    $configFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rh-config-" + [System.Guid]::NewGuid().ToString('N') + '.json')
    Invoke-WebRequest -Uri "$RawBase/config.local.json" -OutFile $configFile -UseBasicParsing | Out-Null
  } catch {
    Fail "拉取接入配置失败：检查网络，或下载技能包后运行本脚本"
  }
}

try {
  $config = Get-Content -Raw -Encoding UTF8 $configFile | ConvertFrom-Json
} catch {
  Fail "接入配置读不出来：技能包可能不完整，重新装一次"
}
$mcpUrl = $config.mcpUrl
if (-not $mcpUrl) { Fail '接入配置里没有 mcpUrl：技能包可能不完整，重新装一次' }

# --- 宿主 ----------------------------------------------------------------
function Test-HostInstalled([string]$Host_) {
  switch ($Host_) {
    'claude' { return [bool](Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.claude") }
    'pi' { return [bool](Get-Command pi -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.agents") -or (Test-Path "$env:USERPROFILE\.pi") }
  }
  return $false
}

function Get-HostSkillDir([string]$Host_) {
  switch ($Host_) {
    'claude' { return "$env:USERPROFILE\.claude\skills" }
    'pi' { return "$env:USERPROFILE\.agents\skills" }
  }
  return $null
}

$hosts = @()
foreach ($h in @('claude', 'pi')) {
  if (Test-HostInstalled $h) { $hosts += $h }
}
if ($hosts.Count -eq 0) { Fail '没有检测到 Claude Code 或 pi：先装好其中一个宿主再运行本脚本' }

# --- 装技能 --------------------------------------------------------------
$skillReady = $false
if ($skillDir) {
  $parent = Split-Path -Parent $skillDir
  $grandparent = Split-Path -Parent $parent
  foreach ($h in $hosts) {
    if ($grandparent -eq (Get-HostSkillDir $h)) { $skillReady = $true }
  }
}

if ($skillReady) {
  Write-Note "技能已就位：$skillDir"
} elseif ($skillDir) {
  foreach ($h in $hosts) {
    $target = Join-Path (Get-HostSkillDir $h) $SkillName
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse $skillDir $target
    Write-Note "技能已安装：$target"
  }
} else {
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail '没有 npx：改用下载技能包后运行本脚本'
  }
  Write-Note '正在用 skills CLI 安装技能…'
  & npx --yes skills add $Repo --skill $SkillName --global --yes | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail '技能安装失败：检查网络后重试' }
  Write-Note "技能已安装（${Repo}）"
}

# --- 登记禅道 MCP -------------------------------------------------------
function Register-Claude {
  $current = (& claude mcp get zentao 2>$null | Out-String)
  if ($current -and $current.Contains($mcpUrl)) {
    Write-Note 'Claude Code：禅道 MCP 已是最新，跳过登记'
    return
  }
  if ($current -and $current.Trim()) {
    Write-Note 'Claude Code：已有 zentao 条目但地址与技能包不一致——在 Agent 里说「更新禅道地址」，它只改这一个键'
    return
  }
  & claude mcp add --transport http zentao $mcpUrl --scope user | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Claude Code：登记禅道 MCP 失败' }
  Write-Note 'Claude Code：已登记禅道 MCP（地址不回显）'
}

function Register-Pi {
  $current = (& pi mcp list 2>$null | Out-String)
  if ($current -and $current.Contains($mcpUrl)) {
    Write-Note 'pi：禅道 MCP 已是最新，跳过登记'
    return
  }
  if ($current -match 'zentao') {
    Write-Note 'pi：已有 zentao 条目但地址与技能包不一致——在 Agent 里说「更新禅道地址」，它只改这一个键'
    return
  }
  & pi mcp add zentao --url $mcpUrl | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'pi：登记禅道 MCP 失败' }
  Write-Note 'pi：已登记禅道 MCP（地址不回显）'
}

foreach ($h in $hosts) {
  if ($h -eq 'claude') {
    if (-not $Force -and (Get-Process claude -ErrorAction SilentlyContinue)) {
      Fail 'Claude Code 正在运行：运行中的 Claude Code 会回写 ~/.claude.json，登记好的条目可能丢失。先退出 Claude Code 再跑这条命令（确实要继续就加 -Force）。'
    }
    Register-Claude
  } else {
    Register-Pi
  }
}

# --- 写入本人凭据 -------------------------------------------------------
if ($SkipCredentials) {
  Write-Note '凭据：已跳过（本人之后自己写）'
} else {
  $credScript = Join-Path $scriptDir 'set-credentials.ps1'
  if (-not (Test-Path $credScript)) {
    $credScript = Join-Path ([System.IO.Path]::GetTempPath()) ("rh-set-credentials-" + [System.Guid]::NewGuid().ToString('N') + '.ps1')
    try {
      Invoke-WebRequest -Uri "$RawBase/scripts/set-credentials.ps1" -OutFile $credScript -UseBasicParsing | Out-Null
    } catch {
      Fail '拉取凭据脚本失败：检查网络，或下载技能包后运行本脚本'
    }
  }
  Write-Note '接下来输入你自己的禅道账号和密码（密码不回显，只写在你自己的机器上）'
  & powershell -ExecutionPolicy Bypass -File $credScript
}

# --- 收尾 ---------------------------------------------------------------
Write-Note ''
Write-Note '装好了。接下来：'
Write-Note '  1. 重启你的 AI Agent：Claude Code 退出重开；pi 执行 /reload'
Write-Note '  2. 在 Agent 里说：验证一下禅道连接'
Write-Note '  3. 之后直接说：帮我提个 Bug'
