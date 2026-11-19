# 接入禅道：装 CLI、写凭据、自检

技能访问禅道走**官方禅道 CLI**（npm 包 `zentao-cli`，可执行文件 `zentao`）。首次接入是三件事：**装固定版本的 CLI**（当前宿主里的 Agent 代办）、**写本人的接入凭据**（终端用户本人输入）、**只读自检**（报出当前账号可见的产品）。业务用户粘一段提示词给 Agent 就能走完；管理员看最后一节「管理员」（地址与 CLI 版本从哪来、分发）。

## Agent 执行路径

当前宿主里的 Agent 按这五步走；终端用户只参与第 2 步（在自己终端里写凭据）。

### 1. 装官方禅道 CLI（版本固定，Agent 代办）

技能的接入配置钉着 CLI 版本（`skills/rh-product-feedback/config.local.json`）：

```json
{ "zentaoCli": { "package": "zentao-cli", "version": "0.4.4" } }
```

按它装、按它校验：**不要装 `latest`，也不要顺手升级**。

```bash
node --version                      # 先确认有 Node.js 18+（官方 CLI 的运行环境）
zentao version --format=json        # 看装了没、装的是哪个版本（没装就是找不到命令）
npm install -g zentao-cli@<接入配置里 zentaoCli.version 的值>
zentao version --format=json        # 校验 data.cli 与接入配置里的版本一致
```

- 版本号**只认接入配置**：上面那句 `0.4.4` 是当前值，包内 `config.local.json` 才是真相。升级由发版流程显式发起（改 `zentaoCli.version` → 重新分发），Agent 不自行升级，也不跟着上游新版跑。
- **没有 node**（`node --version` 报找不到）：如实说「本机没有 Node.js，装不了禅道 CLI」，按「装不上时」给禅道网页端的替代路径。
- **装不上**（权限、代理、离线、`npm` 全局目录不在 PATH）：如实说明卡在哪一步，同样给网页端的替代路径。**不要退回用宿主里的禅道 MCP 工具建单**——它的身份是服务端配置的固定身份，单据不会留痕在提交人名下。
- Windows 用 PowerShell 跑同样的命令；`npm prefix -g` 的目录要能被找到，否则 CLI 装上了脚本仍报「找不到 zentao 命令」。

### 2. 写本机凭据（终端用户本人输入）

`bash <技能目录>/scripts/set-credentials.sh --path` 给出本机凭据文件位置。文件在 → 跳到第 3 步；不在 → 请终端用户**在自己终端**跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Agent 的命令环境没有可交互的输入，替用户输密码会把密码带进对话）。Windows 用 `scripts\set-credentials.ps1`。

凭据由**本人**输入：Agent 不代劳、不索要、不回显——不要问账号、密码、令牌，也不要让终端用户把凭据贴在对话里。要用个人令牌就 `--token`（禅道「个人 → 令牌」生成，可单独撤销）。

### 3. 接入自检（只读）

```bash
node <技能目录>/scripts/zentao.mjs products
```

- **成功** → 输出里那批产品就是**当前账号可见的产品，也就是后续选品范围**（选产品、查重、建单都只能落在这里面）。如实报「凭据此刻起已生效，你的账号能看到 N 个产品」。
- **失败** → 先看 CLI 装没装、版本对不对（报「找不到 zentao 命令」就是没装或不在 PATH），再看凭据文件在不在；凭据无效时脚本会报「禅道拒绝了本机凭据」，让终端用户在自己机器上重写凭据，不要在对话里索要密码。**不要**向终端用户索要禅道地址、IP、端口或账号密码——这些都能自己拿到。
- **只读**：自检不写任何禅道数据——不建单、不更新、不上传。

### 4. 连不上时怎么查（按需触发）

地址核对**按需触发**：只在连不上或正在走安装流程时才看地址，不要每次会话都去读宿主配置。地址只有一处来源——技能包内的 `config.local.json`（`zentaoWebUrl`），不主动回显具体值；交付单据链接时才拼给终端用户。

| 现象 | 原因 | 下一步 |
| --- | --- | --- |
| 报「找不到 zentao 命令」 | CLI 没装，或不在 PATH | 回第 1 步按固定版本装，装完校验版本 |
| 脚本提示没有凭据文件 | 本机凭据还没写 | 请终端用户跑一次凭据脚本（第 2 步），Agent 不代输 |
| 报「禅道拒绝了本机凭据」 | 账号、密码或令牌不对 | 让终端用户在自己机器上重写凭据；不反复试，连续失败会锁号 |
| 报禅道地址无法访问 | 不在内网、换过实例，或配置里的地址不对 | 确认网络，找管理员核对 `config.local.json`；不要自己改技能包里的文件 |
| 产品列表是空的 | 账号没有可见产品 | 如实说明权限边界，指出该找谁开权限 |

### 5. 不登记禅道 MCP

首次接入**不再登记禅道 MCP**，也不需要它：装 CLI、写凭据、自检三步走完，技能自己就能读写。它的定位见下面「禅道 MCP：只给人手动查看」。

如实汇报：分别说清「CLI 装好了没、版本对不对」「凭据已写入 / 还没写入」「自检过了没、能看到几个产品」。没验证过不要说「装好了、能提反馈了」。

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
6. **不用重做接入**：接入凭据在本机的凭据文件里（`~/.config/rh-zentao/credentials`）、本机偏好（默认产品、默认负责人）在本机偏好文件里、官方禅道 CLI 装在系统里（全局 npm 包，版本由技能包接入配置钉住）——三处都不在技能目录里，更新不会动。照实说「不用重新写密码、不用重装 CLI」。
7. **报版本号**：更新完读技能目录里 `SKILL.md` 的 `metadata.rh-version` 报给终端用户；读不到就说读不到。

### 临时副本

`npx skills use` 落在临时目录里的技能没有更新入口——想拿新版就重新跑一次 `use`。

## 业务用户：粘一段提示词

### 1. 安装提示词

把下面这段发给你正在用的 Agent（与仓库的 [`docs/quick-start.md`](https://github.com/xuxzh/ruihui-skills/blob/main/docs/quick-start.md) 速查逐字一致，由 `tests/validate-skills.mjs` 校验）：

```
帮我装上 ruihui 的产品反馈助手（rh-product-feedback），并接上禅道：
1. 技能没装的话，先运行 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，然后读它输出的路径下的 `SKILL.md`；第一次装完按它给的提示重载（Claude Code 退出重开，pi 执行 `/reload`）。
2. 由你代我装官方禅道 CLI（npm 包 `zentao-cli`），版本固定取技能包 `config.local.json` 里 `zentaoCli.version` 的值，装好校验版本对得上；没有 node 或装不上就如实告诉我，并给我禅道网页端的替代路径。
3. 告诉我怎么写入我自己的禅道账号密码——密码必须由我在自己的终端里输入，别替我输、也别写进对话。
4. 凭据写好之后跑一次接入自检，报出我这个账号可见的产品，并说明凭据此刻起有没有生效。
```

你用的是 pi、Claude Code、Codex 还是别的 Agent 都一样——**装 CLI、装技能都发生在你正在对话的这个宿主里**，不用挑、不用配；凭据始终由你自己在自己的终端里输入。

### 2. 写账号密码

Agent 会把这条命令原样贴给你，复制到**自己的终端**跑：

```bash
bash ~/.agents/skills/rh-product-feedback/scripts/set-credentials.sh
```

（Windows 用 `scripts\set-credentials.ps1`。）密码不回显，只写在你自己的机器上。

### 3. 让 Agent 做接入自检

凭据写好就能用，**不用重载**（CLI 与凭据都不在宿主配置里）。第一次装技能时宿主才需要重载一次：Claude Code 退出重开，pi 执行 `/reload`，其它宿主按 Agent 给的提示（见下面「各宿主配置」）。

重载完（或本来就在跑）在 Agent 里说：

> 验证一下禅道连接

它会用你的凭据换一个属于你账号的令牌、读一次产品列表（这就是你的可见范围），报出你账号能看到的产品，并如实告诉你凭据此刻起有没有生效。提单后单据留痕在你的账号名下——交付时会核对提交人是不是你。

之后直接说要提什么就行。提交成功后会给你一条可点的禅道直达链接，想自己核对时点开即可。

### 不装技能、只想试一次

不想让技能常驻，用 skills CLI 的 `use`（技能落在临时目录，不写进宿主）：

```
用 `npx skills use xuxzh/ruihui-skills@rh-product-feedback` 拿到这个技能的说明并照着做：把它输出的完整内容先存到临时文件再读；它给的 supporting-files 目录就是技能目录，`SKILL.md` 里的相对路径都从那里解析。然后按其中「0. 环境自检」装上技能包里固定版本的官方禅道 CLI，并告诉我怎么写入我自己的账号密码。
```

### 装不上时

装不上 CLI 不等于提不了单——**先给禅道网页端的替代路径**，由终端用户自己在网页上提。不要退回用宿主里的禅道 MCP 工具建单（那是服务端配置的固定身份）。

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| Agent 说找不到技能 / 读不到 `SKILL.md` | 技能没装到宿主能发现的位置 | 让 Agent 跑 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，或把技能包解压到宿主技能目录 |
| Agent 说本机没有 node | 缺 Node.js，官方 CLI 跑不起来 | 装 Node.js 18+ 后重试；装不了就用禅道网页端提单 |
| Agent 说 CLI 装不上 | 权限、代理、离线，或 npm 全局目录不可写 | 换有网/有权限的环境装，或改用禅道网页端；技能与凭据不受影响 |
| 装完 Agent 仍说找不到 `zentao` 命令 | `npm prefix -g` 的目录不在 PATH | 把它加进 PATH 再复查一次 |
| 登录失败 | 账号或密码不对 | 核对后重跑凭据脚本；不要反复试，连续失败可能锁号 |
| 装完没反应 | 宿主还没加载新技能 | Claude Code 退出重开；pi 执行 `/reload`；其它宿主按上面的对照表 |

**禅道网页端**：用浏览器打开禅道地址，进「产品 → 反馈」新建反馈，「测试 → Bug」新建缺陷——这两处就是 Agent 平时写的那两张单据，字段也要得少，先提上去再补细节。

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
| **入口脚本换令牌**（默认） | 不会 | 入口脚本 `scripts/zentao.mjs` 自己读凭据文件、直连禅道换一个属于当前账号的当次令牌，再以环境变量 `ZENTAO_URL` / `ZENTAO_ACCOUNT` / `ZENTAO_TOKEN` 注入官方禅道 CLI 子进程。密码与令牌只在脚本进程内：不进命令行参数、不打印、不进上下文 |
| **个人令牌**（可选，更易撤销） | 不会 | 凭据文件里写 `ZENTAO_TOKEN` 时直接用，不再换令牌。禅道「个人 → 令牌」生成，可单独撤销、可设有效期 |

单据留痕在**换到令牌的禅道账号**名下——这就是「每用户独立账号」在服务端的落点。宿主里的禅道 MCP 工具走不到这条路：它的身份是服务端配置的固定身份（见「禅道 MCP：只给人手动查看」）。

## 默认产品

「默认产品」分两层：**随包默认**（公司级、分发者预置）与**本机默认**（用户自己的、只对本人生效）。两层都只是默认值——用户这次明说的产品永远优先。

### 随包默认产品（公司级）

写在技能包内的 `config.local.json`：

```json
{
  "zentaoWebUrl": "…",
  "zentaoCli": { "package": "zentao-cli", "version": "0.4.4" },
  "defaultProduct": { "id": 1, "name": "MOMV2.0" }
}
```

- `id` 为 `null` 或缺失 = 没预置，技能当没设默认产品处理。
- 同一个文件里钉着**官方禅道 CLI 的固定版本**（`zentaoCli.version`）：升级 CLI 就是改这个值再分发，不在运行时升级。
- **谁写**：管理员在仓库里改 `config.local.json` 并随包分发（见 ADR-0005 的分发流程）；走 skills CLI 装的用户直接拿到这份配置，内网包的包内配置由 `scripts/build-internal-package.mjs` 生成。
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

1. 用入口脚本 `node <技能目录>/scripts/zentao.mjs products` 打出的可见产品确认它在当前账号可见范围内（不可见就如实说明，让用户换一个）。
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

接入选的是**官方禅道 CLI**，它装在机器上、不登记进宿主，所以各宿主之间只差两件事：**技能目录在哪**、**怎么让新装/更新的技能生效**。

| 宿主 | 技能目录 | 让新技能生效 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/rh-product-feedback` | 退出重开 |
| pi | `~/.agents/skills/rh-product-feedback` | `/reload` |
| Codex | 按宿主文档的技能目录 | 重开会话 |
| OpenCode | 按宿主文档的技能目录 | 重开 |
| 其它宿主 | 按宿主文档 | 按宿主文档 |

- **不用登记 MCP**：首次接入不碰宿主配置，各宿主的 MCP 配置都不需要改。宿主能跑命令（`node`、`zentao`）就够了。
- **不用改技能包里的 `config.local.json`**：地址与固定的 CLI 版本都在里面，由管理员维护；终端用户没同意不要动（见 SKILL.md 硬约束 8）。
- **Windows**：命令一样跑，路径分隔符换成 `\`；`bash` 换成 PowerShell 脚本（`set-credentials.ps1`）。

## 禅道 MCP：只给人手动查看

禅道 MCP 是团队自研的、把禅道 OpenAPI 暴露成 MCP 工具的服务。**它不在接入链路里**：技能的读、写、传图都走官方禅道 CLI。

- **身份不是提交人自己**：MCP 工具的身份是**服务端配置的固定禅道账号**（实测它的登录接口 `post_users_login` 不校验传入凭据）。经这些工具提交的单据，创建者是这个固定账号，不是终端用户。
- **只适合无关紧要的查看**：翻一下产品、看看单据标题这类不给别人看的动作可以；**建单与更新一律不用它**——否则单据的提交人不对，也不是本人留痕。
- **不要为了「顺手」退回它**：CLI 没装、装不上、本机没有 node 时给禅道网页端的替代路径，也不改用宿主里的禅道 MCP 工具建单。
- **谁想自己登记就用来自便**：那是终端用户自己在宿主里加的一条 MCP 条目，与技能无关；技能不依赖它、也不去改它。别为了让两边一致去改技能包里的 `config.local.json`。
- 已知限制（要改得在服务端改）：① 只接受服务端配置的固定身份，不接受按传入凭据登录；② 上传没有内容通道（`post_files` 只认文件名）；③ 返回体大、字段要手工投影。

## 禅道查询器（只读）

读路径由随包**入口脚本** `scripts/zentao.mjs` 承担：换当次令牌 → 经环境变量注入官方禅道 CLI → 由 CLI 取数 → 脚本投影成十几行表格。禅道列表接口的原始响应是几十 KB 到上百 KB 的 JSON，直接进 Agent 上下文会被截断（实测一次提单据有 8 分钟耗在这上面），所以取值与投影都在进程内做完，Agent 只拿表格。

```bash
node <技能目录>/scripts/zentao.mjs products                    # 当前账号可见的产品（就是后续选品范围）
node <技能目录>/scripts/zentao.mjs projects                    # 可见项目
node <技能目录>/scripts/zentao.mjs projects --product 29       # 只看某个产品下面的项目
```

- **前置**：Node.js 18+（用 `fetch`）与**官方禅道 CLI**（`zentao` 命令，npm 包 `zentao-cli`）装好且在 PATH 里。没有 node 或没有 CLI 时如实告诉终端用户并给替代路径（禅道 Web 端自提）；CLI 不在 PATH 时脚本报「找不到 zentao 命令」并退出非 0。
- **凭据**：脚本自己读本机凭据文件并换当前账号的当次令牌，密码与令牌不打印、不进命令行参数、不进上下文。没写凭据时它会提示去跑 `set-credentials.sh`。
- **地址**：从技能包的 `config.local.json`（`zentaoWebUrl`）读，不回显；交付单据链接时才拼给终端用户。
- **环境变量**（测试用）：`ZENTAO_WEB_URL` 覆盖禅道站点地址（换令牌用），`ZENTAO_CREDENTIALS_FILE` 覆盖凭据文件路径，`ZENTAO_PACKAGE_CONFIG_FILE` 覆盖随包配置路径。
- **写操作不走它**：建单、更新暂时仍用写入脚本（见下），后续并入入口脚本。
- **迁移期**：旧的 `scripts/zentao-query.mjs`（含 `bugs` / `feedbacks` / `bug` / `feedback` / `prep` / `qd` / `check` / `sync`）仍在包里、仍然可用，但技能默认不再走它；Windows 的 `scripts\zentao-query.ps1` 同理。

## 禅道写入脚本

随包的 `scripts/zentao-write.mjs` 负责**写**：建反馈单、建缺陷单、更新正文。它用本机凭据换一个属于当前账号的令牌，带着令牌调禅道 MCP，只发一次请求，只把结果 JSON 交给 Agent。

迁移期它仍是写入的主力（读路径已经换到 `scripts/zentao.mjs`）；写子命令随后并入同一个入口脚本，届时本节整体下移到入口脚本。

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

接入自检**只读**：不建单、不更新、不上传任何禅道数据。

1. `node <技能目录>/scripts/zentao.mjs products` → 报出**当前账号可见的产品**（就是后续选品范围），如实说「凭据此刻起已生效，能看到 N 个产品」。
2. 失败时按 [error-handling.md](error-handling.md) 处理，并说清是哪一层：没 node / 没装 CLI / 版本不对 / 没写凭据 / 地址不通 / 凭据无效。
3. 想在宿主里直接调禅道工具：**首次接入不登记**（见「禅道 MCP：只给人手动查看」）。

## 管理员

### 禅道地址与 CLI 版本从哪来

地址与 CLI 版本都写在技能包内的 `config.local.json`：

```json
{
  "zentaoWebUrl": "<禅道 Web 端地址>",
  "zentaoCli": { "package": "zentao-cli", "version": "0.4.4" },
  "mcpUrl": "<可选：团队禅道 MCP 地址，只给想手动查看的人用>"
}
```

- `config.local.json` **进仓库**、随技能包一起分发（见 ADR-0005）。地址本身不是凭据，内网 IP 也不从公网可达。
- 三个字段各管一件事：`zentaoWebUrl` 用于拼单据直达链接（`<zentaoWebUrl>/feedback-view-<反馈 ID>.html`），也是脚本换令牌用的站点地址；`zentaoCli.version` 是**官方禅道 CLI 的固定版本**，Agent 装 CLI 时只认它；`mcpUrl` 只为想自己手动登记团队禅道 MCP 的人保留，不参与接入。
- **CLI 版本的升级由发版流程显式发起**：改 `zentaoCli.version` → 跑一次接入自检验证 → 重新分发。技能不跟着上游新版自动升级，也不在运行时升级。
- `zentaoWebUrl` 为空或写错：技能仍能提反馈，只是交付时给不了链接，只能给反馈编号——换实例时记得一起改。
- 换成别的禅道实例时，直接改 `config.local.json` 里的地址字段；仓库里没有单独的占位符模板文件。
- 地址用 IP：公司没有内网 DNS 域名可指禅道。IP 随网络调整时改这个文件再分发一次。

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
