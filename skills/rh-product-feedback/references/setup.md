# 连接禅道 MCP

业务用户粘一段提示词给当前的 Agent 就能接上；管理员看「禅道地址从哪来」与「分发」。

## Agent 执行路径

当前宿主里的 Agent 按这四步走；终端用户只参与第 3 步（在自己终端里写凭据）。

### 1. 能不能连上禅道

随包脚本直连禅道 MCP，不依赖宿主里是否登记了 MCP 工具。先跑一次：

```bash
node <技能目录>/scripts/zentao-query.mjs products
```

- **成功** → 跳到第 4 步；输出的产品列表就是当前账号的可见范围。
- **失败** → 继续第 2、3 步。**不要**向终端用户索要禅道地址、IP、端口或账号密码——这些都能自己拿到。

### 2. 核对地址（按需触发）

不要每次会话都去读宿主配置（那里可能有凭据类文件）。核对只在两种情况下发生：连不上、或走安装流程。

```bash
node <技能目录>/scripts/zentao-query.mjs check    # 只给结论（一致 / 不一致）
node <技能目录>/scripts/zentao-query.mjs sync     # 把宿主里的 zentao 地址改成技能包的（只改 url）
```

当前宿主不是 Claude Code / pi 时加 `--config <宿主 MCP 配置文件>`（必要时再加 `--pointer <条目路径>`）。`sync` 只改 `zentao` 条目的 `url`，写前备份。

**不要为了让两边一致去改技能包里的 `config.local.json`**——那是分发下来的文件，终端用户没同意不要动（见 SKILL.md 硬约束 8）。

### 3. 写本机凭据

`bash <技能目录>/scripts/set-credentials.sh --path` 给出本机凭据文件位置。在 → 跳到第 4 步；不在 → 请终端用户**在自己终端**跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Agent 的命令环境没有可交互的输入，替用户输密码会把密码带进对话）。Windows 用 `scripts\set-credentials.ps1`。

### 4. 登记禅道 MCP 到宿主（可选）

地址来自技能包内的 `config.local.json`（`mcpUrl`）。**登记与否都不影响技能自己的读写**——随包脚本自己连禅道。登记的价值是：终端用户在自己的对话里也能直接调禅道工具。

**但要记住一条**：宿主里那些工具的身份是禅道 MCP 服务端配置的固定账号，**经它们提交的禅道单据会留痕在那个账号名下**，不是终端用户自己。所以它们只适合随便看看，**建单与更新一律走随包的写入脚本**。

要登记时：**你在当前宿主里自己登记**——程序不认识宿主，宿主配置在哪、怎么写，见下面「各宿主配置」。

1. 优先用宿主自己的 MCP 命令：`claude mcp add --transport http zentao <地址> --scope user`、`pi mcp add zentao --url <地址>`、`codex mcp add zentao --url <地址>`。
2. 条目已存在但地址不同、或宿主没有这类命令 → 改宿主配置文件：只动 `zentao` 这一个条目（不存在就新增，已存在就只改 `url`，保留 `headers` 等其他字段），**写回前先备份**，写回后复核。
3. 回读复核：读回宿主配置里的 `zentao` 条目，确认地址与 `config.local.json` 一致；不一致就只改 `url`（`check` 给结论、`sync` 修正）。
4. 提示生效方式：Claude Code 退出重开；pi 执行 `/reload`；其它宿主按「各宿主配置」的对照表。**生效之后**再验证。

如实汇报：分别说清「禅道 MCP 已登记 / 没登记（不影响技能读写）」「凭据已写入 / 还没写入」「需要让宿主重载」。没验证过不要说「装好了、能提反馈了」。

### 5. 认证与接入自检

- **认证在脚本里做，Agent 不插手**：本机凭据 → 直连禅道换一个属于当前账号的令牌 → 随令牌访问禅道 MCP。密码与令牌只在脚本进程内，不打印、不进上下文（见 [zentao-mcp.md](zentao-mcp.md)「身份与认证」）。Agent 不调 `post_users_login`、不用 curl 调试登录接口。
- **接入自检**：跑一次查询器 `products`，确认真的连上了，并用它列出**当前账号可见的产品**——这批产品就是后续选产品的候选范围。失败按 [error-handling.md](error-handling.md) 处理。
- **凭据无效**时脚本会报错退出（如「禅道拒绝了本机凭据」）：让终端用户在自己机器上重写凭据，不要在对话里索要密码；连续失败可能触发禅道锁号，不要反复试。

自检通过就直接进入终端用户的诉求（收集要素、查重、草稿），不要插入「自检报告 → 等确认」的往返；只在认证失败、产品不可见时停下来。

## 更新技能

终端用户问「技能有新版吗」「更新一下 rh-product-feedback」时走这一节。**更新由 skills CLI 完成，技能包自己不参与**——技能没被加载也能更新。

### 用户侧提示词

把下面这段发给你正在用的 Agent（与仓库的 [`docs/quick-start.md`](https://github.com/xuxzh/ruihui-skills/blob/main/docs/quick-start.md) 的「更新技能」逐字一致，由 `tests/validate-skills.mjs` 校验）：

```
帮我更新 ruihui 的产品反馈助手（rh-product-feedback）：
1. 先跑 `npx skills check`。没有新版就告诉我「已是最新」，到此为止；如果它报我改过技能里的文件（local changes），先告诉我会覆盖什么，等我确认再动。
2. 有新版就跑 `npx skills update rh-product-feedback`。
3. 更新完告诉我三件事：更新到了哪个版本（读技能目录里 SKILL.md 的 `rh-version`）、我的禅道凭据还在不在（只说在与不在，别回显内容）、以及要不要重载才能生效。
```

### Agent 执行路径

1. **查**：`npx skills check`。它列出所有可更新的技能，也报出技能目录里被手改过的文件（`has local changes`）。有新版或本地改动时退出码是 1——那是「有东西要动」的信号，不是失败。
2. **有本地改动先问**：更新会覆盖技能目录里的文件。终端用户改过 `SKILL.md`、`config.local.json` 或脚本时，先说清会覆盖什么，等终端用户确认再动。
3. **更新**：`npx skills update rh-product-feedback`。带技能名时不问范围，project 与 global 都会找；`-g` 只更全局、`-p` 只更项目、`-y` 跳过范围提示。
4. **没走过 skills CLI 的安装**（实施人员直接拷贝的文件夹）没有锁条目，`skills update` 找不到它——让实施人员给一份新包覆盖旧目录，不要自己去改技能包的文件。
5. **重载才生效**：更新换的是磁盘上的文件，运行中的宿主还在用旧版本。按「各宿主配置」提示终端用户重载（Claude Code 退出重开；pi 执行 `/reload`）。
6. **不用重做接入**：接入凭据在本机的凭据文件里（`~/.config/rh-zentao/credentials`）、本机偏好（默认产品、默认负责人）在本机偏好文件里、禅道 MCP 登记在宿主配置里——三处都不在技能目录里，更新不会动。照实说「不用重新写密码、不用重新登记」。
7. **报版本号**：更新完读技能目录里 `SKILL.md` 的 `metadata.rh-version` 报给终端用户；读不到就说读不到。

### 临时副本

`npx skills use` 落在临时目录里的技能没有更新入口——想拿新版就重新跑一次 `use`。

## 业务用户：粘一段提示词

### 1. 安装提示词

把下面这段发给你正在用的 Agent（与仓库的 [`docs/quick-start.md`](https://github.com/xuxzh/ruihui-skills/blob/main/docs/quick-start.md) 速查逐字一致，由 `tests/validate-skills.mjs` 校验）：

```
帮我装上 ruihui 的产品反馈助手（rh-product-feedback），并接上禅道：
1. 技能没装的话，先运行 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，然后读它输出的路径下的 `SKILL.md`。
2. 按这份 `SKILL.md` 的「0. 环境自检」确认能连上禅道：地址在技能包的 `config.local.json`。顺便也把禅道 MCP 登记到**你这个宿主**里（可选，只是让我在对话里也能直接调禅道工具；登记不登记都不影响我提单据）。
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

它会用你的凭据换一个属于你账号的令牌，读一次产品列表（这就是你的可见范围），并如实告诉你凭据此刻起没起作用。提单后单据留痕在你的账号名下——交付时会核对提交人是不是你。

之后直接说要提什么就行。提交成功后会给你一条可点的禅道直达链接，想自己核对时点开即可。

### 不装技能、只想试一次

不想让技能常驻，用 skills CLI 的 `use`（技能落在临时目录，不写进宿主）：

```
用 `npx skills use xuxzh/ruihui-skills@rh-product-feedback` 拿到这个技能的说明并照着做：把它输出的完整内容先存到临时文件再读；它给的 supporting-files 目录就是技能目录，`SKILL.md` 里的相对路径都从那里解析。然后按其中「0. 环境自检」把禅道 MCP 登记到你这个宿主的配置里，并告诉我怎么写入我自己的账号密码。
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
| **随包脚本换令牌**（读写都用它） | 不会 | 随包的 `scripts/zentao-query.mjs`（读）与 `scripts/zentao-write.mjs`（写）自己读凭据文件、直连禅道换一个属于当前账号的令牌，再带着令牌访问禅道 MCP。密码与令牌只在脚本进程内，不打印、不进上下文 |
| **个人令牌**（可选，更易撤销） | 不会 | 凭据文件里写 `ZENTAO_TOKEN` 时直接用它，不再换令牌。禅道「个人 → 令牌」生成，可单独撤销、可设有效期 |

单据留痕在**换到令牌的禅道账号**名下——这就是「每用户独立账号」在服务端的落点。

> 实测补充：禅道 MCP 的 `post_users_login` **不校验**传入凭据，恒以服务端配置的一个固定身份对外服务（见 [zentao-mcp.md](zentao-mcp.md)「身份与认证」）。但它**接受调用方自带的禅道令牌**：请求头带 `Authorization: Bearer <用户令牌>` 时，它就按那个令牌的身份去调禅道。随包脚本走的就是这条路；宿主里直接调 MCP 工具则走不到——那些工具的身份是服务端的固定账号。

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

## 默认负责人（缺陷单）

**接入层默认跟产品的 QD 走**：经禅道 MCP 建缺陷单时若不写负责人，单子会落到该产品的 QD（质量负责人）名下——实测 MOMV2.0 的 QD 是 `majiawei`，不传就挂在他名下；QD 为空的产品则不指派。本技能靠显式写 `assignedTo: ""` 挡住这个默认。

本技能把它做成一个设置：**随包默认 = 不指派**（缺陷单先不落到任何人名下），想改就配下面两个键。

取值（字符串）：

| 值 | 含义 | 载荷里怎么写 |
| --- | --- | --- |
| `""`（随包默认） | 不指派 | 补 `assignedTo: ""` |
| `"qd"`（代码兜底） | 产品 QD 承接 | **不带** `assignedTo` 字段 |
| 别的字符串 | 指给该禅道账号 | 补 `assignedTo: "<账号>"` |

解析顺序：**终端用户明说 > 本机默认 > 随包默认 > 缺省（`qd`）**。

- 终端用户明说指派给谁（或明确说不指派）→ 载荷里直接写 `assignedTo`，**盖过配置**。
- 两级来源，**本机优先**：

| 来源 | 位置 | 范围 |
| --- | --- | --- |
| 随包默认（公司级） | 技能包 `config.local.json` 的 `bugAssignee` | 所有装了这个包的人 |
| 本机默认（用户级） | 偏好文件 `~/.config/rh-zentao/preferences.json` 的 `bugAssignee` | 只对本人生效 |

```json
{ "defaultProduct": { "id": 1, "name": "MOMV2.0" }, "bugAssignee": "" }
```

- 写入脚本在 `bug-create` 时按上面的顺序解析并补字段（见 [SKILL.md](../SKILL.md)「写单据」）；反馈单没有这个字段。
- 这个设置的来龙去脉见 [ADR-0016](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/adr/0016-默认负责人跟产品QD走且可配置.md)；随包默认改成不指派的理由见 [ADR-0018](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/adr/0018-随包默认负责人改为不指派.md)。
- 禅道里查不出「离职」——用户表里只有 `deleted` / `locked` 是硬失效标记，账号还在但人已离职查不出来。所以 QD 指向谁要靠**看得见**：草稿与交付都写出 QD 是谁（查询器 `qd --product <产品ID>` 给 QD 账号、姓名与账号状态）。

### 怎么设

用户在对话里说「以后提 bug 默认不指派」「以后提 bug 都指给张三」时，Agent：

1. 把要写的值（`""` / `"qd"` / 账号名）给用户确认。
2. 合并写进偏好文件的 `bugAssignee`（别覆盖掉文件里已有的 `defaultProduct`）。
3. 回读复核文件内容，再告诉用户「默认负责人已设为 …」。

### 怎么用

- 草稿的负责人一栏按生效值**具名**写：生效值是「不指派」就写「未指派」（随包默认如此）；是产品 QD 就写谁，QD 为空写「未指派（该产品没有 QD）」；用户指名就写他的账号。
- 建单后回读核对 `assignedTo`，与生效值对不上就如实说明，不要默认识可。
- 偏好文件不存在或格式坏了 → 当作没设，用随包默认（不指派）；两层都没配才兜底到产品 QD。

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
node <技能目录>/scripts/zentao-query.mjs qd --product 29    # 产品的默认承接人（QD 账号 + 姓名 + 账号状态）
node <技能目录>/scripts/zentao-query.mjs check   # 宿主地址是否与技能包一致（只给结论）
node <技能目录>/scripts/zentao-query.mjs sync     # 把宿主里的 zentao 地址改成技能包的（只改 url）
```

- **前置**：Node.js 18+（用 `fetch`）。没有 node 时没法读写——如实告诉终端用户并给替代路径（禅道 Web 端自提）。
- **凭据**：脚本自己读本机凭据文件并换当前账号的令牌，密码与令牌不打印、不进上下文。没写凭据时它会提示去跑 `set-credentials.sh`。
- **地址**：从技能包的 `config.local.json` 读；`check` / `sync` **只输出结论**，不回显地址。`sync` 只改宿主配置里 `zentao` 条目的 `url`，写前备份。宿主不是 Claude Code / pi 时加 `--config <宿主 MCP 配置文件>`（必要时 `--pointer <条目路径>`）。
- **环境变量**（测试用）：`ZENTAO_MCP_URL` 覆盖禅道 MCP 地址，`ZENTAO_WEB_URL` 覆盖禅道 Web 地址（换令牌用），`ZENTAO_CREDENTIALS_FILE` 覆盖凭据文件路径，`ZENTAO_PACKAGE_CONFIG_FILE` 覆盖随包配置路径，`ZENTAO_PREFERENCES_FILE` 覆盖本机偏好文件路径。
- **写操作不走它**：建单、更新用写入脚本（见下）。

Windows 用 `scripts\zentao-query.ps1`（PowerShell）。

## 禅道写入脚本

随包的 `scripts/zentao-write.mjs` 负责**写**：建反馈单、建缺陷单、更新正文。它用本机凭据换一个属于当前账号的令牌，带着令牌调禅道 MCP，只发一次请求，只把结果 JSON 交给 Agent。

```bash
node <技能目录>/scripts/zentao-write.mjs feedback-create --payload-file <路径>
node <技能目录>/scripts/zentao-write.mjs feedback-update --id <反馈 ID> --payload-file <路径>
node <技能目录>/scripts/zentao-write.mjs bug-create      --payload-file <路径>
node <技能目录>/scripts/zentao-write.mjs bug-update      --id <缺陷 ID> --payload-file <路径>
```

- **载荷**：文件里放 payload 的内容本身（**不要再套一层 `payload`**），例如 `{"productID": 42, "title": "…", "openedBuild": ["trunk"], "steps": "<正文 HTML>"}`。也可以用 `--payload '<JSON>'` 或 `--payload-stdin`。
- **输出**：stdout 一行 JSON。成功：`{"ok":true,"kind":"bug-create","id":"1945","status":"success","message":"保存成功"}`；失败：stderr 一行「错误：…」，退出码非 0；结果不确定：`{"ok":false,"uncertain":true,…}`。
- **只发一次**：禅道创建接口没有幂等键，重发会造两条记录。脚本不做重试。
- **缺陷单的负责人由脚本按配置补**（见「默认负责人」）：载荷里没写 `assignedTo` 时，脚本按「终端用户明说 > 本机默认 > 随包默认 > 缺省（产品 QD）」解析——随包默认是 `""`（补空串，不指派），`"qd"` 不带这个字段（产品 QD 承接），别的值补该账号。
- **前置**：Node.js 18+；凭据与地址的读法与查询器一致。
- **为什么不用宿主里的禅道 MCP 工具写**：那些工具的身份是服务端配置的固定账号，单据会留痕在那个账号名下（见 [zentao-mcp.md](zentao-mcp.md)「身份与认证」）。

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

1. 跑一次查询器 `products`：能返回产品列表即说明连上了——这份列表就是当前账号的**可见范围**，之后提反馈只能选这里面的产品。
2. 凭据无效时脚本会报错退出，按 [error-handling.md](error-handling.md) 的「认证失败」处理。
3. 想在宿主里直接调禅道工具（可选）：工具列表里有 `post_users_login`、`get_products`、`post_feedbacks`（工具名可能带 `mcp__zentao__` 前缀）。这些工具的身份是服务端固定账号，只适合查看。

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

**只有走 skills CLI 装的才有自动更新**（`npx skills check` / `npx skills update`）。走备用渠道拷贝目录的用户没有更新入口——技能内容变了要重新分发一份，覆盖旧目录（见上面「更新技能」）。

### 禅道 MCP 侧可改进的两点

1. **支持请求头令牌**：接受 `Authorization: Bearer <禅道令牌>`，让凭据由宿主客户端注入，Agent 全程不接触凭据文件。
2. **登录失败可辨识**：账号或密码错误、账号被锁定，返回可区分的错误信息，Agent 才能给出「密码错了」和「账号被锁了，去解锁」两种不同提示，避免连续重试触发锁定。
