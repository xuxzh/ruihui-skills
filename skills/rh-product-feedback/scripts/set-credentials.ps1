# 写入本机禅道接入凭据：交互式输入，密码不回显，落到只有本人可读的文件里。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File set-credentials.ps1
#   powershell -ExecutionPolicy Bypass -File set-credentials.ps1 -Token
#   powershell -ExecutionPolicy Bypass -File set-credentials.ps1 -Path
#
# 凭据文件（Windows）：%APPDATA%\rh-zentao\credentials
#   内容两行：ZENTAO_ACCOUNT=<账号> / ZENTAO_PASSWORD=<密码>
#   用令牌时第二行是 ZENTAO_TOKEN=<令牌>
#
# 脚本不回显、不打印、不上传任何凭据内容，也不依赖当前工作目录。
param([switch]$Path, [switch]$Token)

$ErrorActionPreference = 'Stop'

function Get-CredentialsPath {
  $base = $env:APPDATA
  if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Roaming' }
  return (Join-Path (Join-Path $base 'rh-zentao') 'credentials')
}

$target = Get-CredentialsPath

if ($Path) {
  Write-Output $target
  exit 0
}

if ($Token) {
  $key = 'ZENTAO_TOKEN'
  $label = '令牌'
} else {
  $key = 'ZENTAO_PASSWORD'
  $label = '密码'
}

$account = Read-Host '禅道账号'
if (-not $account) {
  Write-Error '账号为空，未写入。'
  exit 1
}

$secure = Read-Host "禅道$label（输入不回显）" -AsSecureString
$secret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $secret) {
  Write-Error "$label 为空，未写入。"
  exit 1
}

$dir = Split-Path -Parent $target
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$content = "ZENTAO_ACCOUNT=$account`n$key=$secret`n"
[System.IO.File]::WriteAllText($target, $content)
Remove-Variable secret, secure

Write-Output "已写入 $target"
