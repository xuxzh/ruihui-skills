# 连接禅道 MCP

业务用户只需要三步；管理员看「各宿主配置」与「内网地址从哪来」。

## 业务用户：三步

### 1. 把技能包放进通用技能目录

通用技能目录是 `~/.agents/skills/`（Windows：`%USERPROFILE%\.agents\skills\`），大多数 Agent 宿主都能从这里加载技能。

macOS / Linux：

```bash
mkdir -p ~/.agents/skills && cp -r <解压目录>/rh-product-feedback ~/.agents/skills/
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse "<解压目录>\rh-product-feedback" "$env:USERPROFILE\.agents\skills\"
```

### 2. 对 Agent 说「帮我连上禅道」

Agent 会读技能包里的 `config.local.json`（内网地址写死在里面），按你用的宿主把禅道 MCP 登记进去，然后告诉你还差一步。

### 3. 写入你自己的禅道凭据

Agent 会给你一条命令，**你自己在终端执行**，输入禅道账号和令牌（密码）。凭据落在你自己机器上，Agent 不经手、看不到、也不会写进任何仓库。

写完之后回到 Agent 说一句「好了」，它会自检连接，然后就能提反馈了。

## 接入凭据

### 用令牌，不要用密码

禅道「个人 → 令牌」里生成 API token。优先用令牌：可单独撤销、可设有效期，误贴出去不影响账号密码。令牌与密码都支持，令牌优先。

### 存放位置与格式

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `~/.config/rh-zentao/credentials` |
| Windows | `%APPDATA%\rh-zentao\credentials` |

文件内容是两行 `KEY=VALUE`：

```
ZENTAO_ACCOUNT=<你的禅道账号>
ZENTAO_TOKEN=<你的禅道令牌>
```

用密码时把第二行换成 `ZENTAO_PASSWORD=<你的禅道密码>`。

### 三种写入方式（任选其一）

**Node（跨平台，交互式，输入不回显）**——内部分发包内含该脚本：

```bash
node scripts/set-credentials.mjs
```

**macOS / Linux（bash）**：

```bash
mkdir -p ~/.config/rh-zentao && chmod 700 ~/.config/rh-zentao && \
read -r -p "禅道账号: " A && read -r -s -p "禅道令牌: " T && echo && \
umask 077 && printf 'ZENTAO_ACCOUNT=%s\nZENTAO_TOKEN=%s\n' "$A" "$T" > ~/.config/rh-zentao/credentials && \
echo "已写入 ~/.config/rh-zentao/credentials"
```

**Windows（PowerShell）**：

```powershell
$dir = "$env:APPDATA\rh-zentao"
New-Item -ItemType Directory -Force $dir | Out-Null
$account = Read-Host "禅道账号"
$token = Read-Host "禅道令牌" -AsSecureString
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
Set-Content -Path "$dir\credentials" -Value "ZENTAO_ACCOUNT=$account`nZENTAO_TOKEN=$plain"
Remove-Variable plain, token
Write-Host "已写入 $dir\credentials"
```

文件权限：macOS / Linux 用 `chmod 600`；Windows 依赖用户目录本身的 ACL，不要放到共享盘。

### 两种鉴权模式

| 模式 | 凭据是否进入 Agent 上下文 | 说明 |
| --- | --- | --- |
| **会话登录**（当前默认） | 会（读文件时） | Agent 调 `post_users_login` 换 token，后续调用沿用。优先用令牌，泄露面小且可撤销 |
| **请求头令牌** | 不会 | 若禅道 MCP 支持 `Authorization: Bearer <令牌>`，凭据由宿主客户端从环境变量注入，Agent 全程看不到。当前 MCP 是否支持，见「管理员」一节 |

## 各宿主配置

MCP server 名为 `zentao`，类型是 Streamable HTTP，地址取自 `config.local.json` 的 `mcpUrl`。用宿主自带命令注册最稳；需要手改文件时用下面的片段。

### pi

命令：

```bash
pi mcp add zentao --url "<mcpUrl>"
```

文件（`~/.pi/agent/mcp.json`）：

```json
{
  "mcpServers": {
    "zentao": {
      "url": "<mcpUrl>"
    }
  }
}
```

### Claude Code

命令：

```bash
claude mcp add zentao "<mcpUrl>" --transport http --scope user
```

文件（用户级 `~/.claude.json` 的 `mcpServers`，或项目级 `.mcp.json`）：

```json
{
  "mcpServers": {
    "zentao": {
      "type": "http",
      "url": "<mcpUrl>"
    }
  }
}
```

改完配置后需要重连或重启宿主，让新 server 生效。

## 自检

登记完成后确认三件事：

1. 工具列表里有 `post_users_login`、`get_products`、`post_feedbacks`（工具名可能带 `mcp__zentao__` 前缀）。
2. `post_users_login` 成功返回。
3. `get_products` 能返回产品列表——这份列表就是当前账号**可见**的产品范围，之后提反馈只能选这里面的产品。

只做只读调用，不写任何反馈单。

## 管理员

### 内网地址从哪来

地址写在技能包内的 `config.local.json`：

```json
{
  "mcpUrl": "<禅道 MCP 的 Streamable HTTP 地址>",
  "zentaoWebUrl": "<禅道 Web 端地址>"
}
```

- `config.local.json` **不进仓库**（已在 `.gitignore` 里），随内部分发包一起发出。
- 仓库里的 `config.example.json` 只有占位符。
- 优先用内网域名而不是 IP：IP 会随网络调整失效，也更容易被误贴到外部。

### 分发渠道

技能包内容与分发渠道无关，下面几种都能用，按现有 IT 条件选一个：

| 渠道 | 用户侧动作 |
| --- | --- |
| 内网 Git 仓库 | `git clone` 后复制目录 |
| NAS / 内网对象存储 / 共享盘 | 下载压缩包 → 解压进通用技能目录 |
| 公司软件中心 / 应用市场 | 在软件中心点安装 |
| 终端管理（Intune / 域策略 / MDM） | 无需操作，机器上已有 |

分发包里应包含：`skills/rh-product-feedback/`（含 `config.local.json`）与 `scripts/set-credentials.mjs`。

### 禅道 MCP 侧可改进的两点

1. **支持请求头令牌**：接受 `Authorization: Bearer <禅道令牌>`，让凭据由宿主客户端注入，Agent 全程不接触凭据文件。
2. **登录失败可辨识**：账号或密码错误、账号被锁定，返回可区分的错误信息，Agent 才能给出「密码错了」和「账号被锁了，去解锁」两种不同提示，避免连续重试触发锁定。
