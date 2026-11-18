# 连接禅道 MCP

业务用户跑一条安装命令；管理员看「禅道地址从哪来」与「分发」。

## 业务用户：一条命令

### 1. 装技能

```bash
npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global
```

skills CLI 把技能装到 `~/.agents/skills/rh-product-feedback/`，再按宿主建入口：Claude Code 得到 `~/.claude/skills/rh-product-feedback`（软链），pi 直接用 `~/.agents/skills/`。也可以直接从 GitHub 下载技能包、解压后放到上面任一路径。

### 2. 跑安装脚本

```bash
# Claude Code（主宿主）
bash ~/.claude/skills/rh-product-feedback/scripts/install.sh
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\rh-product-feedback\scripts\install.ps1"
```

用 pi 把路径里的 `.claude` 换成 `.agents`。

脚本一次做完三件事：

1. 从技能包里的 `config.local.json` 读禅道地址（地址不回显，也不出现在对话里）。
2. 把禅道 MCP 登记到检测到的宿主（Claude Code / pi）。
3. 让你输入**自己的**禅道账号和密码，写进本机凭据文件——密码不回显，文件只有你能读。

脚本可以重复跑：已装好的部分会跳过，地址一致就什么都不改。

### 3. 重启 Agent，然后验证

- Claude Code：退出重开。运行中的 Claude Code 会回写 `~/.claude.json`，所以**先把宿主退出再跑脚本**；脚本检测到宿主还在跑会直接停下提示你。
- pi：执行 `/reload`，不用重启。

重开后，在 Agent 里说：

> 验证一下禅道连接

它会登录禅道、读一次产品列表（这就是你的可见范围），并如实告诉你凭据此刻起没起作用——当前禅道 MCP 恒以服务端固定身份服务（见「实测补充」），所以它会说明「凭据已写入，但提交人暂时是服务端账号」。

之后直接说要提什么就行。

### 装不上时

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| 脚本说没有检测到宿主 | Claude Code 和 pi 都没装 | 先装其中一个宿主再跑 |
| 脚本说 Claude Code 正在运行 | 运行中的宿主会覆盖配置 | 退出 Claude Code 再跑（或加 `--force`） |
| 装完连不上 | 地址不一致或条目被覆盖 | 在 Agent 里说「更新禅道地址」，它只改 `zentao` 这一个键；或再跑一次脚本 |
| 登录失败 | 账号或密码不对 | 核对后重跑脚本的凭据步骤；不要反复试，连续失败可能锁号 |
| 装完没反应 | 技能刚装上，宿主还没加载 | Claude Code 退出重开；pi 执行 `/reload` |

## 接入凭据

### 用密码为主，令牌可选

默认用禅道账号 + 密码：业务用户不必先去禅道生成令牌，少一个操作。令牌也支持——禅道「个人 → 令牌」里生成，可单独撤销、可设有效期，误贴出去不影响账号密码；愿意用令牌的人可以跑：

```bash
bash ~/.claude/skills/rh-product-feedback/scripts/set-credentials.sh --token
```

### 存放位置与格式

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `~/.config/rh-zentao/credentials` |
| Windows | `%APPDATA%\rh-zentao\credentials` |

文件内容是两行 `KEY=VALUE`：

```
ZENTAO_ACCOUNT=<你的禅道账号>
ZENTAO_PASSWORD=<你的禅道密码>
```

用令牌时把第二行换成 `ZENTAO_TOKEN=<你的禅道令牌>`。

文件权限：macOS / Linux 用 `chmod 600`；Windows 依赖用户目录本身的 ACL，不要放到共享盘。

### 两种鉴权模式

| 模式 | 凭据是否进入 Agent 上下文 | 说明 |
| --- | --- | --- |
| **会话登录**（当前默认） | 会 | Agent 读本机凭据文件 → 调 `post_users_login` 换会话令牌 → 后续调用沿用。优先用可单独撤销的令牌，泄露面小 |
| **请求头令牌** | 不会 | 若禅道 MCP 支持 `Authorization: Bearer <令牌>`，凭据由宿主客户端从环境变量注入，Agent 全程不碰凭据文件。当前 MCP 是否支持，见「管理员」一节 |

「Agent 完全看不到你的令牌」是**不准确**的说法：会话登录模式下 Agent 会读取凭据文件。准确的说法是——凭据由你自己写入，Agent 不会主动展示、回显或外传它。

> 实测补充：当前禅道 MCP 的登录接口**不校验**传入凭据，恒以服务端配置的一个固定身份对外服务（见 `zentao-mcp.md` 的「实测偏差」）。也就是说会话登录这一步目前既不决定操作身份，也基本不会报「登录失败」；「每用户独立账号」要等 MCP 侧修好才成立。凭据读取本身带来的暴露面照旧存在。

## 各宿主配置

MCP server 名为 `zentao`，类型是 Streamable HTTP，地址取自 `config.local.json` 的 `mcpUrl`。安装脚本按下面的规则登记。

### Claude Code（主宿主）

配置文件是用户级 `~/.claude.json` 的 `mcpServers`（项目级 `.mcp.json` 需要逐项目批准，不走这条路）。

登记方式——**只改一个键**：

1. 读 `~/.claude.json`（不存在就当空对象）。
2. 只动 `mcpServers.zentao`：不存在就新增 `{"type":"http","url":"<mcpUrl>"}`；已存在就只更新 `url`，保留 `headers` 等其他字段。
3. 写回前先备份一份 `~/.claude.json.bak-<时间戳>`。
4. 写回后复核：`claude mcp get zentao` 能查到、地址与 `config.local.json` 一致。

**不要用 `claude mcp add` 覆盖**：它遇到同名条目会直接拒绝（`already exists in user config`，地址变了也不更新），也保留不了条目上的其他字段。

改完需要**重开 Claude Code** 才生效。重开后第一件事是复核 `mcpServers.zentao` 还在不在：不在说明被运行中的 Claude Code 回写覆盖，重写一次；仍然不行就让用户再跑一次安装脚本。

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

### 禅道地址从哪来

地址写在技能包内的 `config.local.json`：

```json
{
  "mcpUrl": "<禅道 MCP 的 Streamable HTTP 地址>",
  "zentaoWebUrl": "<禅道 Web 端地址>"
}
```

- `config.local.json` **进仓库**、随技能包一起分发（见 ADR-0005）。地址本身不是凭据，内网 IP 也不从公网可达。
- 仓库里的 `config.example.json` 只有占位符，供他人 fork 时替换用。
- 地址用 IP：公司没有内网 DNS 域名可指禅道 MCP。IP 随网络调整时改这个文件再分发一次。

### 分发

主渠道是公网 `skills.sh`，一条命令装好（装到所有检测到的 Agent）：

```bash
npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global
```

备用渠道与技能内容解耦，按现有 IT 条件选一个：

| 渠道 | 用户侧动作 |
| --- | --- |
| 内网 Git 仓库 | `git clone` 后复制目录 |
| NAS / 内网对象存储 / 共享盘 | 下载压缩包 → 解压进对应宿主的技能目录 |
| 公司软件中心 / 应用市场 | 在软件中心点安装 |
| 终端管理（Intune / 域策略 / MDM） | 无需操作，机器上已有 |

`node scripts/build-internal-package.mjs` 仍能打出自洽的目录（`dist/rh-product-feedback/`），供压缩包分发使用；地址取自仓库里的 `config.local.json`。

### 禅道 MCP 侧可改进的两点

1. **支持请求头令牌**：接受 `Authorization: Bearer <禅道令牌>`，让凭据由宿主客户端注入，Agent 全程不接触凭据文件。
2. **登录失败可辨识**：账号或密码错误、账号被锁定，返回可区分的错误信息，Agent 才能给出「密码错了」和「账号被锁了，去解锁」两种不同提示，避免连续重试触发锁定。
