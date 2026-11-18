# 连接禅道 MCP

业务用户粘一段提示词给当前的 Agent 就能接上；管理员看「禅道地址从哪来」与「分发」。

## 业务用户：粘一段提示词

### 1. 安装提示词

把下面这段发给你正在用的 Agent：

```
帮我装上 ruihui 的产品反馈助手（rh-product-feedback），并接上禅道：
1. 技能没装的话，先运行 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`（它会按你所在的宿主建好入口），然后读它输出的路径下的 `SKILL.md`。
2. 按这份 `SKILL.md` 的「0.2 安装」，把禅道 MCP 登记到**你这个宿主**的配置里：地址在技能包的 `config.local.json`，优先用宿主自己的 MCP 命令；已有条目就只改它的 `url`，其它字段别动；写前备份、写后复核。
3. 告诉我怎么写入我自己的禅道账号密码——密码必须由我在自己的终端里输入，别替我输、也别写进对话。
4. 告诉我怎么让配置生效（重启你，还是执行 `/reload`）。
```

你用的是 pi、Claude Code、Codex 还是别的 Agent 都一样——**登记做在哪个宿主，取决于你在哪个宿主里问**。

### 2. 写账号密码

Agent 会把这条命令原样贴给你，复制到**自己的终端**跑：

```bash
bash ~/.agents/skills/rh-product-feedback/scripts/set-credentials.sh
```

（Windows 用 `scripts\set-credentials.ps1`。）密码不回显，只写在你自己的机器上。

### 3. 让配置生效，然后验证

- Claude Code：退出重开。
- pi：执行 `/reload`。
- 其它宿主：按 Agent 给的提示（见下面「各宿主配置」）。

生效后，在 Agent 里说：

> 验证一下禅道连接

它会登录禅道、读一次产品列表（这就是你的可见范围），并如实告诉你凭据此刻起没起作用——当前禅道 MCP 恒以服务端固定身份服务（见「实测补充」），所以它会说明「凭据已写入，但提交人暂时是服务端账号」。

之后直接说要提什么就行。提交成功后会给你一条可点的禅道直达链接，想自己核对时点开即可。

### 不装技能、只想试一次

不想让技能常驻，用 skills CLI 的 `use`（技能落在临时目录，不写进宿主）：

```
用 `npx skills use xuxzh/ruihui-skills@rh-product-feedback` 拿到这个技能的说明并照着做：把它输出的完整内容先存到临时文件再读；它给的 supporting-files 目录就是技能目录，`SKILL.md` 里的相对路径都从那里解析。然后按其中「0.2 安装」把禅道 MCP 登记到你这个宿主的配置里，并告诉我怎么写入我自己的账号密码。
```

### 装不上时

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| Agent 说找不到技能 / 读不到 `SKILL.md` | 技能没装到宿主能发现的位置 | 让 Agent 跑 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，或把技能包解压到宿主技能目录 |
| Agent 说装好了但连不上 | 地址不一致，或条目被运行中的宿主回写覆盖 | 在 Agent 里说「更新禅道地址」，它只改 `zentao` 这一个键 |
| 登录失败 | 账号或密码不对 | 核对后重跑凭据脚本；不要反复试，连续失败可能锁号 |
| 装完没反应 | 宿主还没加载新配置 | Claude Code 退出重开；pi 执行 `/reload`；其它宿主按上面的对照表 |

## 接入凭据

### 用密码为主，令牌可选

默认用禅道账号 + 密码：业务用户不必先去禅道生成令牌，少一个操作。令牌也支持——禅道「个人 → 令牌」里生成，可单独撤销、可设有效期，误贴出去不影响账号密码；愿意用令牌的人可以跑：

```bash
bash ~/.agents/skills/rh-product-feedback/scripts/set-credentials.sh --token
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
| **会话登录**（写操作的默认） | 会 | Agent 读本机凭据文件 → 调 `post_users_login` 换会话令牌 → 后续写入沿用。优先用可单独撤销的令牌，泄露面小 |
| **查询器登录**（读操作的默认） | 不会 | 随包的 `scripts/zentao-query.mjs` 自己读凭据文件并登录，密码与令牌只在它的进程内，不打印、不进上下文 |
| **请求头令牌** | 不会 | 若禅道 MCP 支持 `Authorization: Bearer <令牌>`，凭据由宿主客户端从环境变量注入，Agent 全程不碰凭据文件。当前 MCP 是否支持，见「管理员」一节 |

「Agent 完全看不到你的令牌」是**不准确**的说法：会话登录模式下 Agent 会读取凭据文件。准确的说法是——凭据由你自己写入，Agent 不会主动展示、回显或外传它。

> 实测补充：当前禅道 MCP 的登录接口**不校验**传入凭据，恒以服务端配置的一个固定身份对外服务（见 `zentao-mcp.md` 的「实测偏差」）。也就是说会话登录这一步目前既不决定操作身份，也基本不会报「登录失败」；「每用户独立账号」要等 MCP 侧修好才成立。凭据读取本身带来的暴露面照旧存在。

## 默认产品

「默认产品」分两层：**随包默认**（公司级、分发者预置）与**本机默认**（用户自己的、只对本人生效）。两层都只是默认值——用户这次明说的产品永远优先。

### 随包默认产品（公司级）

写在技能包内的 `config.local.json`：

```json
{
  "mcpUrl": "…",
  "zentaoWebUrl": "…",
  "defaultProduct": { "id": 1, "name": "MOMV2.0" }
}
```

- `id` 为 `null` 或缺失 = 没预置，技能当没设默认产品处理。
- **谁写**：管理员在仓库里改 `config.local.json` 并随包分发（见 ADR-0005 的分发流程）；`scripts/build-internal-package.mjs` 会把它带进内网包。
- **技能只读不改**：它属于分发下来的文件，运行中的 Agent 不改它（硬约束 13）。
- **怎么用**：选品时它是第二优先（第一优先是用户明说的产品，第三优先是本机默认）。因为它不是用户自己选的，**每次使用都要跟用户确认一句**「默认记到 <产品名> 对吗？」。
- **它会随包分发**：预置的产品对看不见它的账号就是无效值，所以「使用时确认」不是可选项。
- 它当前不可见 → 如实说明并列出可见产品，不静默换产品建单。

### 本机默认产品（用户级）

存在用户自己的机器上，**不进仓库、不进技能包**。

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `~/.config/rh-zentao/preferences.json` |
| Windows | `%APPDATA%\rh-zentao\preferences.json` |

文件内容：

```json
{ "defaultProduct": { "id": 1, "name": "MOMV2.0" } }
```

`id` 是禅道产品 ID（整数），`name` 只是给人看的备注。

### 怎么设

用户在对话里说「默认产品是 <产品名>」时，Agent：

1. 用查询器 `products --match <产品名>` 确认它在当前账号可见范围内（不可见就如实说明，让用户换一个）。
2. 把要写的内容（产品 id + 名称）给用户确认。
3. 写入上面的偏好文件（目录不存在就创建）。
4. 回读复核文件内容，再告诉用户「默认产品已设为 <名称>」。

### 怎么用

- 选产品时：用户这次明说的产品 > 本机默认 > 随包默认（需确认）> 追问一次。
- 本机默认是用户自己设的，**直接用，不再问**。
- 本机默认当前不可见（不在可见产品列表里）→ 如实说明并列出可见产品，**不要静默换产品建单**。
- 偏好文件不存在、格式坏了、或里面的产品 id 已不存在 → 当作没有本机默认，继续看随包默认 / 追问。

**禁止**：把本机默认产品写进技能包的 `config.local.json`。那个文件随技能包分发给所有用户，写进去等于把一个人的产品变成别人的默认值（见 ADR-0005 的边界）。

## 各宿主配置

MCP server 名为 `zentao`，类型是 Streamable HTTP，地址取自 `config.local.json` 的 `mcpUrl`。

**登记做在「当前宿主」——也就是正在跟用户对话的那个 Agent 客户端。** 技能包里不写死宿主清单：Agent 自己知道它在哪个宿主里，照下表对号入座即可。

| 宿主 | MCP 配置文件 | `zentao` 条目 | 登记命令 | 生效方式 |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude.json` 的 `mcpServers.zentao` | `{"type":"http","url":"<mcpUrl>"}` | `claude mcp add --transport http zentao <mcpUrl> --scope user` | 退出重开 |
| pi | `~/.pi/agent/mcp.json` 的 `mcpServers.zentao` | `{"url":"<mcpUrl>"}`（`type` 可选） | `pi mcp add zentao --url <mcpUrl>` | `/reload` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.zentao]` | `url = "<mcpUrl>"` | `codex mcp add zentao --url <mcpUrl>` | 重开会话 |
| OpenCode | `opencode.json` 的 `mcp.zentao` | `{"type":"remote","url":"<mcpUrl>","enabled":true}`（字段名按宿主文档核对） | 无 CLI，改配置文件 | 重开 |
| 其它宿主 | 宿主自己的 MCP 配置 | 通用约定：`mcpServers.zentao` + `url` | 按宿主文档 | 按宿主文档 |

`mcpServers.<name>` + `url` 是 pi、Claude Code、Cursor 等客户端的通用约定（pi 官方文档的迁移表即以此为准），Codex 用 TOML、OpenCode 用自己的键名——**对不上就按宿主文档来，不要硬套**。

### 登记的两条路

1. **优先用宿主自己的 MCP 命令**（上表第 4 列）。它最不容易写坏宿主配置。
2. **条目已存在但地址变了、或宿主没有这类命令** → 改配置文件，按「只改一个键」来：
   1. 读该配置文件（不存在就当空对象）。
   2. 只动 `zentao` 这一个条目：不存在就新增，已存在就只更新 `url`，保留 `headers` 等其他字段。
   3. 写回前先备份一份 `<文件名>.bak-<时间戳>`。
   4. 写回后复核：条目还在、地址与 `config.local.json` 一致。

**不要用 `claude mcp add` 覆盖**：它遇到同名条目会直接拒绝（`already exists in user config`，地址变了也不更新），也保留不了条目上的其他字段。同理 `pi mcp add` 是**整条替换**，会丢掉该条目上已有的其他字段（例如将来加的请求头令牌）。

### 登记发生在宿主运行期间

Agent 就在宿主里，宿主退出时可能回写配置、覆盖刚登记的条目。所以登记后必须**回读复核**；重开会话时若条目不见了，会话自检会自动按 `config.local.json` 把地址补回去（只改 `zentao` 这一个键）。Claude Code 尤其如此——改完需要**重开**才生效。

### 核对地址

```bash
node <技能目录>/scripts/zentao-query.mjs check    # 只给结论（一致 / 不一致）
node <技能目录>/scripts/zentao-query.mjs sync     # 把宿主里的 zentao 地址改成技能包的（只改 url）
```

不传参数时查内置的 Claude Code 与 pi 两处；当前宿主是别的客户端时加 `--config <宿主 MCP 配置文件>`（必要时再加 `--pointer <条目路径>`，默认 `mcpServers.zentao`）。

## 禅道查询器（只读）

随包的 `scripts/zentao-query.mjs` 负责**读**：产品、项目、缺陷/反馈列表、单据详情。它把取数、过滤、投影放在脚本进程内做完，只打印十几行表格——禅道列表接口的原始响应是几十 KB 到上百 KB 的 JSON，直接进 Agent 上下文会被截断（实测一次提单据有 8 分钟耗在这上面）。

```bash
node <技能目录>/scripts/zentao-query.mjs products --match 报表
node <技能目录>/scripts/zentao-query.mjs projects --match 报表
node <技能目录>/scripts/zentao-query.mjs bugs --product 29 --match 切换语言
node <技能目录>/scripts/zentao-query.mjs feedbacks --product 29 --match 切换语言
node <技能目录>/scripts/zentao-query.mjs bug --id 1936
node <技能目录>/scripts/zentao-query.mjs feedback --id 421
node <技能目录>/scripts/zentao-query.mjs prep --product 瑞辉智能报表平台 --match 切换语言
node <技能目录>/scripts/zentao-query.mjs check   # 宿主地址是否与技能包一致（只给结论）
node <技能目录>/scripts/zentao-query.mjs sync     # 把宿主里的 zentao 地址改成技能包的（只改 url）
```

- **前置**：Node.js 18+（用 `fetch`）。没有 node 时改用 MCP 工具分小页取，只把需要的字段抄下来。
- **凭据**：脚本自己读本机凭据文件并登录，密码与令牌不打印、不进上下文。没写凭据时它会提示去跑 `set-credentials.sh`。
- **地址**：从技能包的 `config.local.json` 读；`check` / `sync` **只输出结论**，不回显地址。`sync` 只改宿主配置里 `zentao` 条目的 `url`，写前备份。宿主不是 Claude Code / pi 时加 `--config <宿主 MCP 配置文件>`（必要时 `--pointer <条目路径>`）。
- **环境变量**（测试用）：`ZENTAO_MCP_URL` 覆盖禅道地址，`ZENTAO_CREDENTIALS_FILE` 覆盖凭据文件路径。
- **写操作不走它**：建单、更新、流转一律用 MCP 工具，保留用户确认链路。

Windows 用 `scripts\zentao-query.ps1`（PowerShell）。

## 禅道上传脚本（图片）

随包的 `scripts/zentao-upload.mjs` 负责**传图片**：把本机图片传到禅道，返回文件 ID 与正文里要用的引用标签。禅道 MCP 没有上传通道（`post_files` 只接受文件名），所以这个脚本直连禅道 REST v2（见 [zentao-mcp.md](zentao-mcp.md) 的「图片上传」）。

```bash
node <技能目录>/scripts/zentao-upload.mjs --file <图片路径> --object-type feedback --object-id <反馈 ID>
node <技能目录>/scripts/zentao-upload.mjs --file <图片路径> --object-type bug --object-id <缺陷 ID>
```

- **前置**：Node.js 18+（用 `fetch` 与 `FormData`）。凭据与地址的读法与查询器一致：本机凭据文件 + 技能包 `config.local.json`；令牌只在进程内使用，不打印。
- **只能挂在已存在的单据上**：禅道上传要带单据类型与单据 ID，所以顺序是「先建单 → 再传图 → 再更新正文」。
- **上传后自己核对**：脚本会回读文件字节并比对大小，还会读禅道的文件元数据确认挂在目标单据上；输出「字节核对：一致」才算传上去。
- **失败怎么办**：见 [error-handling.md](error-handling.md) 的「图片上传失败」。上传失败不影响已建好的单据。

## 自检

只做只读调用，不写任何反馈单。

1. 工具列表里有 `post_users_login`、`get_products`、`post_feedbacks`（工具名可能带 `mcp__zentao__` 前缀）。
2. 跑一次查询器 `products`：能返回产品列表即说明连上了——这份列表就是当前账号的**可见范围**，之后提反馈只能选这里面的产品。
3. 要写入时再登录（`post_users_login`），登录失败只重试一次就停。

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
- 两个字段各管一件事：`mcpUrl` 用于登记 MCP；`zentaoWebUrl` 用于拼反馈单直达链接（`<zentaoWebUrl>/feedback-view-<反馈 ID>.html`），提交成功后交付给用户。
- `zentaoWebUrl` 为空或写错：技能仍能提反馈，只是交付时给不了链接，只能给反馈编号——换实例时记得一起改。
- 换成别的禅道实例时，直接改 `config.local.json` 里的这两个字段；仓库里没有单独的占位符模板文件。
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
