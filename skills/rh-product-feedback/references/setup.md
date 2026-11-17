# 连接禅道 MCP

业务用户只需要三步；管理员看「内网地址从哪来」与「打包分发」。

## 业务用户：三步

### 1. 把技能包放进你用的宿主的技能目录

各宿主的技能目录不一样，先看你用哪个：

| 宿主 | 技能目录（macOS / Linux） | Windows |
| --- | --- | --- |
| Claude Code（主宿主） | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` |
| pi（次宿主） | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |

同一个 `rh-product-feedback` 目录在两处都能用，区别只在放哪里。**装错了宿主就发现不了技能。**

管理员分发的是一个自洽的 `rh-product-feedback` 目录，**整个目录**复制进去。

Claude Code：

```bash
mkdir -p ~/.claude/skills && cp -R <解压目录>/rh-product-feedback ~/.claude/skills/
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse "<解压目录>\rh-product-feedback" "$env:USERPROFILE\.claude\skills\"
```

pi：

```bash
mkdir -p ~/.agents/skills && cp -R <解压目录>/rh-product-feedback ~/.agents/skills/
```

复制完目录里应该有 `SKILL.md`、`references/`、`config.local.json`、`scripts/`。少了 `config.local.json` 说明拿到的是不含内网配置的公开版，找管理员要内网版。

装完先确认宿主能发现它：在 Agent 里问一句「你的技能列表里有没有 rh-product-feedback」，**有**才继续下一步；没有就是目录放错了（或宿主还没重载）。

### 2. 对 Agent 说「帮我连上禅道」

Agent 会读技能包里的 `config.local.json`（内网地址写死在里面），把禅道 MCP 登记到你的宿主，然后告诉你需要重开宿主。地址不回显，你也不用填 IP。

宿主不让 Agent 改配置时，改用随包脚本——它自己从 `config.local.json` 读地址，地址不会出现在对话里（路径按你装的宿主换）：

```bash
# Claude Code
bash ~/.claude/skills/rh-product-feedback/scripts/connect.sh
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\rh-product-feedback\scripts\connect.ps1"
```

### 3. 写入你自己的禅道凭据

Agent 会给你一条命令，**你自己在终端执行**，输入禅道账号和令牌（禅道「个人 → 令牌」生成；没有就用密码）。

```bash
# Claude Code
bash ~/.claude/skills/rh-product-feedback/scripts/set-credentials.sh
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\rh-product-feedback\scripts\set-credentials.ps1"
```

脚本交互式输入、令牌不回显，凭据落在你自己机器上、只有你能读。

**写完不用再回来说「好了」**：直接说要提什么，Agent 会自己登录、自检，然后开始收集反馈内容。

> 凭据由你写入，Agent 不会主动展示或回显它；但会话登录模式下 Agent 需要**读取**这个文件去登录，令牌会进入本次会话上下文——所以优先用可单独撤销的禅道令牌，不要用账号密码。

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

文件权限：macOS / Linux 用 `chmod 600`；Windows 依赖用户目录本身的 ACL，不要放到共享盘。

### 两种鉴权模式

| 模式 | 凭据是否进入 Agent 上下文 | 说明 |
| --- | --- | --- |
| **会话登录**（当前默认） | 会 | Agent 读本机凭据文件 → 调 `post_users_login` 换会话令牌 → 后续调用沿用。优先用令牌，泄露面小且可撤销 |
| **请求头令牌** | 不会 | 若禅道 MCP 支持 `Authorization: Bearer <令牌>`，凭据由宿主客户端从环境变量注入，Agent 全程不碰凭据文件。当前 MCP 是否支持，见「管理员」一节 |

「Agent 完全看不到你的令牌」是**不准确**的说法：会话登录模式下 Agent 会读取凭据文件。准确的说法是——凭据由你自己写入，Agent 不会主动展示、回显或外传它。

> 实测补充：当前禅道 MCP 的登录接口**不校验**传入凭据，恒以服务端配置的一个固定身份对外服务（见 `zentao-mcp.md` 的「实测偏差」）。也就是说会话登录这一步目前既不决定操作身份，也基本不会报「登录失败」；「每用户独立账号」要等 MCP 侧修好才成立。凭据读取本身带来的暴露面照旧存在。

## 各宿主配置

MCP server 名为 `zentao`，类型是 Streamable HTTP，地址取自 `config.local.json` 的 `mcpUrl`。

### Claude Code（主宿主）

配置文件是用户级 `~/.claude.json` 的 `mcpServers`（项目级 `.mcp.json` 需要逐项目批准，不走这条路）。

登记方式——**只改一个键**：

1. 读 `~/.claude.json`（不存在就当空对象）。
2. 只动 `mcpServers.zentao`：不存在就新增 `{"type":"http","url":"<mcpUrl>"}`；已存在就只更新 `url`，保留 `headers` 等其他字段。
3. 写回前先备份一份 `~/.claude.json.bak-<时间戳>`。
4. 写回后复核：`claude mcp get zentao` 能查到、地址与 `config.local.json` 一致。

**不要用 `claude mcp add` 覆盖**：它遇到同名条目会直接拒绝（`already exists in user config`，地址变了也不更新），也保留不了条目上的其他字段。

改完需要**重开 Claude Code** 才生效。重开后第一件事是复核 `mcpServers.zentao` 还在不在：不在说明被运行中的 Claude Code 回写覆盖，重写一次；仍然不行就走 `connect.sh` 降级路径。

手工命令（地址从 `config.local.json` 取，不在对话里出现）：

```bash
bash ~/.claude/skills/rh-product-feedback/scripts/connect.sh
```

### pi（次宿主）

配置文件是用户级 `~/.pi/agent/mcp.json`（项目级 `.pi/mcp.json` 需要项目信任）。

`pi mcp add zentao --url <地址>` 是**整条替换**，会丢掉该条目上已有的其他字段（例如将来加的请求头令牌）；要保留就同样按「只改一个键」的方式合并写。

pi 支持 `/reload`：改完配置在会话里执行 `/reload` 就生效，不必重启宿主。

## 自检

只做只读调用，不写任何反馈单。

1. 工具列表里有 `post_users_login`、`get_products`、`post_feedbacks`（工具名可能带 `mcp__zentao__` 前缀）。
2. `post_users_login` 成功返回。
3. `get_products` 能返回产品列表——这份列表就是当前账号的**可见范围**，之后提反馈只能选这里面的产品。

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

### 打包分发

在仓库里打包，产物是顶层自洽的 `rh-product-feedback/` 目录，用户复制这一个目录即完成安装：

```bash
node scripts/build-internal-package.mjs
```

地址来源优先级：命令行参数 > 仓库根 `.env`（`ZENTAO_MCP_URL`、`ZENTAO_BASE_URL`）> 技能目录里的 `config.local.json`。产物默认在 `dist/`（已 gitignore）。

分发渠道与技能内容解耦，下面几种都能用，按现有 IT 条件选一个：

| 渠道 | 用户侧动作 |
| --- | --- |
| 内网 Git 仓库 | `git clone` 后复制目录 |
| NAS / 内网对象存储 / 共享盘 | 下载压缩包 → 解压进对应宿主的技能目录 |
| 公司软件中心 / 应用市场 | 在软件中心点安装 |
| 终端管理（Intune / 域策略 / MDM） | 无需操作，机器上已有 |

### 禅道 MCP 侧可改进的两点

1. **支持请求头令牌**：接受 `Authorization: Bearer <禅道令牌>`，让凭据由宿主客户端注入，Agent 全程不接触凭据文件。
2. **登录失败可辨识**：账号或密码错误、账号被锁定，返回可区分的错误信息，Agent 才能给出「密码错了」和「账号被锁了，去解锁」两种不同提示，避免连续重试触发锁定。
