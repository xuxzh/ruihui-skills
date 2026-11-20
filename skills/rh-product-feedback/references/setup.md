# 接入禅道：装 CLI、写凭据、自检

技能访问禅道走**官方禅道 CLI**（npm 包 `zentao-cli`，可执行文件 `zentao`）。首次接入是三件事：**装固定版本的 CLI**（当前宿主里的 Agent 代办）、**写本人的接入凭据**（终端用户本人输入）、**只读自检**（报出当前账号可见的产品）。业务用户粘一段提示词给 Agent 就能走完；管理员看最后一节「管理员」（地址与 CLI 版本从哪来、分发）。

## Agent 执行路径

当前宿主里的 Agent 按这五步走；终端用户只参与第 2 步（在自己的浏览器里填凭据，不离开对话）。

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
- **没有 node**（`node --version` 报找不到）：**Agent 自己装**，按下面的顺序挑一种，**不要问终端用户选哪个**：
  1. **机器上已有的版本管理器**（`fnm` / `nvm` / `volta` / `asdf`）：用它装 18 以上（当前 LTS 或更新的稳定版）。fnm：`fnm install 22 && fnm default 22`；nvm：`nvm install 22 && nvm alias default 22`；volta：`volta install node@22`。
  2. **没有版本管理器**：macOS 有 Homebrew 就 `brew install node`；Windows 用 `winget install OpenJS.NodeJS.LTS`；都没有就先装 fnm（`curl -fsSL https://fnm.vercel.app/install | bash`）再用它装。
  3. **装完要让宿主重开**：新装的 Node 不会进已经跑着的宿主进程的 PATH——装完告诉终端用户「Node 装好了，重开一下 Agent（或重开终端）再继续」，**等重开**再装 CLI 与做自检。
- **已有 node 但低于 18**：**不要动它**（可能是别的项目在用），用版本管理器在旁边装一个 18+ 的，装 CLI 时用那个 node 的 npm。
- **装不上**（权限、代理、离线、`npm` 全局目录不在 PATH）：如实说明卡在哪一步，同样给网页端的替代路径。**不要退回用宿主里的禅道 MCP 工具建单**——它的身份是服务端配置的固定身份，单据不会留痕在提交人名下。
- Windows 用 PowerShell 跑同样的命令；`npm prefix -g` 的目录要能被找到，否则 CLI 装上了脚本仍报「找不到 zentao 命令」。

### 2. 写本机凭据（终端用户本人在本机页面里填）

不进终端也能写完：Agent 起一个**只监听本机的一次性写入页**，把地址发给终端用户，用户在自己机器的浏览器里填账号密码（或粘个人令牌）就好（[ADR-0022](../../../docs/adr/0022-写凭据走本机一次性页面.md)）。

```bash
node <技能目录>/scripts/connect.mjs          # 起页面（后台驻留，默认 15 分钟），打印 http://127.0.0.1:<端口>/k/<一次性密钥>
node <技能目录>/scripts/connect.mjs wait     # 等用户填完，打印写入结果与可见产品
```

- **先把地址单独发一条给终端用户**（脚本会尝试自动开浏览器；他得点这个地址），**再**跑 `wait` 等结果——不要用一条命令把两步串起来，串起来用户就看不到地址了。`wait` 默认最多等 300 秒，超时退出码 2——服务仍在后台活着，再跑一次 `wait` 就能拿到结果（`status` 看状态，`stop` 关掉）。
- **页面做了什么**：收到账号与密码后先换一次令牌、再用令牌读一次产品列表（只读，不建单）；只有验证通过才写 `~/.config/rh-zentao/credentials`（目录 0700、文件 0600），写完页面自己关掉。用户在页面上当场就能看到「这个账号能看到哪几个产品」。
- **凭据不经过对话**：密码/令牌只从页面进文件，不打印、不落日志、不进命令行历史、不进 Agent 上下文。Agent 照样不索要、不回显。
- **连续 3 次失败页面自己停手**（免得触发禅道锁号），用户核对后让 Agent 重跑 `connect.mjs`。
- **已经写过就跳过**：`node <技能目录>/scripts/connect.mjs` 之前先看凭据文件在不在（`bash <技能目录>/scripts/set-credentials.sh --path` 会给位置），在就直接进第 3 步。
- **兜底**（远程 SSH、没有图形界面、或用户就喜欢终端）：`bash <技能目录>/scripts/set-credentials.sh`（Windows 用 `scripts\set-credentials.ps1`；要用个人令牌就加 `--token`，禅道「个人 → 令牌」生成，可单独撤销）。

凭据由**本人**输入：Agent 不代劳、不索要、不回显——不要问账号、密码、令牌，也不要让终端用户把凭据贴在对话里。

### 3. 接入自检（只读）

```bash
node <技能目录>/scripts/zentao.mjs products
```

- **成功** → 输出里那批产品就是**当前账号可见的产品，也就是后续选品范围**（选产品、查重、建单都只能落在这里面）。如实报「凭据此刻起已生效，你的账号能看到 N 个产品」。
- **失败** → 先看 CLI 装没装、版本对不对（报「找不到 zentao 命令」就是没装或不在 PATH），再看凭据文件在不在；凭据无效时脚本会报「禅道拒绝了本机凭据」，按第 2 步起一次本机页面让终端用户自己重填，不要在对话里索要密码。**不要**向终端用户索要禅道地址、IP、端口或账号密码——这些都能自己拿到。
- **只读**：自检不写任何禅道数据——不建单、不更新、不上传。

### 4. 连不上时怎么查（按需触发）

地址核对**按需触发**：只在连不上或正在走安装流程时才看地址，不要每次会话都去读宿主配置。地址只有一处来源——技能包内的 `config.local.json`（`zentaoWebUrl`），不主动回显具体值；交付单据链接时才拼给终端用户。

| 现象 | 原因 | 下一步 |
| --- | --- | --- |
| 报「找不到 zentao 命令」 | CLI 没装，或不在 PATH | 回第 1 步按固定版本装，装完校验版本 |
| 脚本提示没有凭据文件 | 本机凭据还没写 | 跑 `connect.mjs` 起本机页面，让终端用户自己填（第 2 步），Agent 不代输 |
| 报「禅道拒绝了本机凭据」 | 账号、密码或令牌不对 | 让终端用户在自己机器上重写凭据；不反复试，连续失败会锁号 |
| 报禅道地址无法访问 | 不在内网、换过实例，或配置里的地址不对 | 确认网络，找管理员核对 `config.local.json`；不要自己改技能包里的文件 |
| 产品列表是空的 | 账号没有可见产品 | 如实说明权限边界，指出该找谁开权限 |

### 5. 不登记禅道 MCP

首次接入**不再登记禅道 MCP**，也不需要它：装 CLI、写凭据、自检三步走完，技能自己就能读写。它的定位见下面「禅道 MCP：只给人手动查看」。

如实汇报：分别说清「CLI 装好了没、版本对不对」「凭据已写入 / 还没写入」「自检过了没、能看到几个产品」。没验证过不要说「装好了、能提反馈了」。

## 重装 / 更新

终端用户说「技能有新版吗」「更新一下 rh-product-feedback」「重装一下」时走这一节。**首装和重装用同一段提示词**（见下面「业务用户：粘一段提示词」）——终端用户不需要知道现在是哪一版，更不需要在几种方案里挑：**判断与清理由 Agent 自己做**。

**更新由 skills CLI 完成，技能包自己不参与**——技能没被加载也能更新。

### Agent 执行路径

按顺序走完，每一步自己判断，**不要把版本判断抛给终端用户**：

1. **定位技能目录并判版本**：在当前宿主的技能目录里找 `rh-product-feedback`（pi `~/.agents/skills/`、Claude Code `~/.claude/skills/`，其它宿主按其文档）。看两样：有没有 `scripts/zentao.mjs`（已是当前通道）；没有、却有 `scripts/zentao-query.mjs` 或 `references/zentao-mcp.md`，就是**旧通道的旧版**；两样都没有 = 没装过。判完只报结论（「你装的是旧版，我给你更新成新版」），不要问终端用户「你现在是哪一版」。
2. **更新或安装技能本体**：
   - 走过 skills CLI 的（`~/.agents/.skill-lock.json` 里有条目）：`npx skills check` 有新版就跑 `npx skills update rh-product-feedback`（带技能名时不问范围；`-g` 只更全局、`-p` 只更项目、`-y` 跳过范围提示）。
   - 锁条目没了的（手动拷过、或锁文件被删）：`skills update` 找不到它 → 直接 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global` 重新装一份。**装之前先删旧技能目录**，别让新旧文件混在一处。
   - 终端用户改过技能目录里的文件时（`skills check` 报 `has local changes`），先说清会覆盖什么，等他确认再动——这是唯一需要终端用户拍板的地方。
3. **装禅道 CLI（版本固定）**：按接入配置 `zentaoCli` 装锁定版本；`zentao version --format=json` 已经和锁定版本一致就跳过，不一致才装（不装 latest）。步骤见上面「1. 装官方禅道 CLI」。
4. **清掉旧通道的残留（旧版才有）**：删技能目录里作废的旧文件——`scripts/zentao-client.mjs`、`scripts/zentao-query.mjs`、`scripts/zentao-query.sh`、`scripts/zentao-query.ps1`、`scripts/zentao-write.mjs`、`scripts/zentao-upload.mjs`、`references/zentao-mcp.md`。**必须删**：留着它们，skills CLI 会一直报这个技能「有本地改动」，更新看起来像没生效。删完再跑一次 `npx skills check` 确认干净。
5. **复用本机凭据**：凭据文件（`~/.config/rh-zentao/credentials`）在就**不重写**、不回显；不在才请终端用户在自己终端跑一次 `set-credentials.sh`。
6. **删掉旧通道的登记（默认做）**：旧版装的时候在宿主里登记过禅道 MCP，现在用不上了——删掉它（Claude Code：`claude mcp remove zentao`；pi：`pi mcp remove zentao`）。报告里带一句「以后这个技能用不上它了，你要是想自己手动查禅道，说一声我再装回来」，**不为此打断他**。除这条旧登记外不改宿主配置。
7. **重载 + 只读自检**：按「各宿主配置」让终端用户重载（Claude Code 退出重开；pi 执行 `/reload`），然后跑 `node <技能目录>/scripts/zentao.mjs products`，报出：更新到的版本（读 `SKILL.md` 的 `metadata.rh-version`）、CLI 版本、凭据在不在、能看到几个产品。**没重载不算完**：运行中的宿主还在用旧版的 SKILL.md。
8. **不用重做接入**：凭据在本机凭据文件里、本机偏好在本机偏好文件里、禅道 CLI 装在系统里——三处都不在技能目录里，重装不会动。照实说「不用重新写密码、不用重装工具」。

### 临时副本

`npx skills use` 落在临时目录里的技能没有更新入口——想拿新版就重新跑一次 `use`。

### 发布线只有一条

技能只从公网 `skills.sh` 分发（见下面「管理员 → 分发」）。手动拷贝进来的目录没有更新入口：跑一次上面那段提示词，Agent 会用 skills CLI 重新装一份并清掉残留。

## 业务用户：粘一段提示词

### 1. 安装 / 重装提示词

首装和重装用**同一段**——把下面这段发给你正在用的 Agent（与仓库的 [`docs/quick-start.md`](https://github.com/xuxzh/ruihui-skills/blob/main/docs/quick-start.md) 速查逐字一致，由 `tests/validate-skills.mjs` 校验）：

```
帮我把 ruihui 的产品反馈助手（rh-product-feedback）装好，已经装过就更新到最新：
1. 技能：来源是 GitHub 公开仓库 https://github.com/xuxzh/ruihui-skills ，装它用 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`（`npx` 需要 Node.js 18+，没有就先按第 2 条装上）；当前是装好的旧版还是根本没装，你自己判断，不用问我——没装就装这条命令，已经装过但不是最新就跑 `npx skills update rh-product-feedback`；装不上就直说，别从别处找同名技能。
2. 禅道工具：先确认这台机器上有 Node.js 18 以上，没有就装一个（用机器上已有的版本管理器，没有就装官方的），再把技能要求的那个禅道工具装好——版本固定取技能包 `config.local.json` 里 `zentaoCli.version` 的值，不要装最新版；已经装好且版本对得上就跳过。
3. 我的账号密码：给我一个只在我这台机器上打开的一次性页面来填（技能自带的 `scripts/connect.mjs`）——密码只由我本人输入，别替我输、也别让我把密码贴进对话；这台机器上已经写过就不用再写。
4. 收尾：跑一次只读自检，报出我这个账号可见的产品，并说明凭据此刻起有没有生效。
```

你用的是 pi、Claude Code、Codex 还是别的 Agent 都一样——**装技能、装禅道工具、写凭据都发生在你正在对话的这个宿主里**，不用挑、不用配，也不用开终端；凭据始终由你自己在浏览器页面里输入。**已经是最新的话，把这段原样再发一次就行**：它不会动你的密码，也不会重装工具。

### 2. 写账号密码

Agent 会在你机器上打开一个**只监听本机的一次性页面**（地址形如 `http://127.0.0.1:<端口>/k/<一次性密钥>`），你在页面上填禅道账号和密码（或粘禅道「个人 → 令牌」生成的个人令牌），提交即可：

- 页面会当场验证：先换一次令牌、再用令牌读一次产品列表（只读），通过才写进你本机的凭据文件（目录 0700、文件 0600）。
- 密码不回显、不进对话、也不进命令行历史；页面写完自己关掉。
- 连续 3 次登录失败会自动停手（免得触发钱道锁号），核对后让 Agent 重开一次页面。

如果页面打不开（远程 SSH、没有图形界面）或你更喜欢终端，就跑一次 `bash <技能目录>/scripts/set-credentials.sh`（Windows 用 `scripts\set-credentials.ps1`），效果一样。

### 3. 让 Agent 做接入自检

凭据写好就能用，**不用重载**（CLI 与凭据都不在宿主配置里）。第一次装技能时宿主才需要重载一次：Claude Code 退出重开，pi 执行 `/reload`，其它宿主按 Agent 给的提示（见下面「各宿主配置」）。

重载完（或本来就在跑）在 Agent 里说：

> 验证一下禅道连接

它会用你的凭据换一个属于你账号的令牌、读一次产品列表（这就是你的可见范围），报出你账号能看到的产品，并如实告诉你凭据此刻起有没有生效。提单后单据留痕在你的账号名下——交付时会核对提交人是不是你。

之后直接说要提什么就行。提交成功后会给你一条可点的禅道直达链接，想自己核对时点开即可。

### 不装技能、只想试一次

不想让技能常驻，用 skills CLI 的 `use`（技能落在临时目录，不写进宿主）：

```
用 `npx skills use xuxzh/ruihui-skills@rh-product-feedback` 拿到这个技能的说明并照着做：把它输出的完整内容先存到临时文件再读；它给的 supporting-files 目录就是技能目录，`SKILL.md` 里的相对路径都从那里解析。然后按其中「0. 接入自检」装上技能包里固定版本的官方禅道 CLI，并告诉我怎么写入我自己的账号密码。
```

### 装不上时

装不上 CLI 不等于提不了单——**先给禅道网页端的替代路径**，由终端用户自己在网页上提。不要退回用宿主里的禅道 MCP 工具建单（那是服务端配置的固定身份）。

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| Agent 说找不到技能 / 读不到 `SKILL.md` | 技能没装到宿主能发现的位置 | 让 Agent 跑 `npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，或把技能包解压到宿主技能目录 |
| Agent 说本机没有 node | 缺 Node.js，官方 CLI 跑不起来 | 让 Agent 装一个（优先用机器上已有的版本管理器，没有就装官方的），装完**重开宿主**再试；实在装不上就用禅道网页端提单 |
| Agent 说 CLI 装不上 | 权限、代理、离线，或 npm 全局目录不可写 | 换有网/有权限的环境装，或改用禅道网页端；技能与凭据不受影响 |
| 装完 Node 后仍说找不到 `zentao` 命令 | 宿主进程还拿着旧的 PATH | 重开宿主（Claude Code 退出重开；pi 执行 `/reload`）再试 |
| 装完 Agent 仍说找不到 `zentao` 命令 | `npm prefix -g` 的目录不在 PATH | 把它加进 PATH 再复查一次 |
| 登录失败 | 账号或密码不对 | 在页面里核对重填（连续 3 次会自动停手）；不要反复试，连续失败可能锁号 |
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
- **谁写**：管理员在仓库里改 `config.local.json` 并随技能包分发（见 ADR-0005 的分发流程）；装技能的人直接拿到这份配置。
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

**禅道自己默认跟产品的 QD 走**：建缺陷单时若不写负责人，单子会落到该产品的 QD（质量负责人）名下——实测不传 `assignedTo` 就挂在该产品的 QD 名下；QD 为空的产品则不指派。本技能靠显式写 `assignedTo: ""` 挡住这个默认（所以随包默认「不指派」也是显式写出来的）。

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

- 入口脚本在 `bug-create` 时按上面的顺序解析并补字段（见 [SKILL.md](../SKILL.md)「写单据」）；反馈单没有这个字段。
- 这个设置的来龙去脉见 [ADR-0016](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/adr/0016-默认负责人跟产品QD走且可配置.md)；随包默认改成不指派的理由见 [ADR-0018](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/adr/0018-随包默认负责人改为不指派.md)。
- **QD 指向谁现在就查得到**：入口脚本 `qd --product <产品ID>` 给出 QD 账号、姓名、账号状态（已删除 / 已锁定 / 可用）与最后登录——草稿里**具名写**「产品 QD：<账号>（<姓名>）」，不要只写「由产品 QD 承接」。禅道里查不出「离职」（用户表里只有 `deleted` / `locked` 是硬失效标记）；QD 账号在用户表里查不到、或状态是已删除 / 已锁定，就如实说查不到或账号不可用，**仍然不猜**。

### 怎么设

用户在对话里说「以后提 bug 默认不指派」「以后提 bug 都指给张三」时，Agent：

1. 把要写的值（`""` / `"qd"` / 账号名）给用户确认。
2. 合并写进偏好文件的 `bugAssignee`（别覆盖掉文件里已有的 `defaultProduct`）。
3. 回读复核文件内容，再告诉用户「默认负责人已设为 …」。

### 怎么用

- 草稿的负责人一栏按生效值**具名**写：生效值是「不指派」就写「未指派」（随包默认如此）；是产品 QD 就用 `node <技能目录>/scripts/zentao.mjs qd --product <产品ID>` 查出账号与姓名，写成「产品 QD：<账号>（<姓名>）」；该产品没有 QD 写「未指派（该产品没有 QD）」；QD 账号在用户表里查不到或已删除 / 已锁定就如实转述；用户指名就写他的账号。
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

- **不用登记 MCP**：首次接入不碰宿主配置，各宿主的 MCP 配置都不需要改。宿主能跑命令（`node`、`zentao`）就够了。（重装时会删掉旧版登记的那一条，见「重装 / 更新」。）
- **不用改技能包里的 `config.local.json`**：地址与固定的 CLI 版本都在里面，由管理员维护；终端用户没同意不要动（见 SKILL.md 硬约束 8）。
- **Windows**：命令一样跑，路径分隔符换成 `\`；`bash` 换成 PowerShell 脚本（`set-credentials.ps1`）。

## 禅道 MCP：只给人手动查看

禅道 MCP 是团队自研的、把禅道 OpenAPI 暴露成 MCP 工具的服务。**它不在接入链路里**：技能的读、写、传图都走官方禅道 CLI。

- **身份不是提交人自己**：MCP 工具的身份是**服务端配置的固定禅道账号**（实测它的登录接口 `post_users_login` 不校验传入凭据）。经这些工具提交的单据，创建者是这个固定账号，不是终端用户。
- **身份分两种，别混**：第二账号实测，随包入口脚本建单的创建者（`openedBy`）就是账号本人；宿主里的禅道 MCP 工具调用不带用户令牌，创建者仍是那个固定账号。所以「脚本能写」不等于「宿主工具能写」——建单与更新只走官方 CLI。
- **只适合无关紧要的查看**：翻一下产品、看看单据标题这类不给别人看的动作可以；**建单与更新一律不用它**——否则单据的提交人不对，也不是本人留痕。
- **不要为了「顺手」退回它**：CLI 没装、装不上、本机没有 node 时给禅道网页端的替代路径，也不改用宿主里的禅道 MCP 工具建单。
- **谁想自己登记就用来自便**：那是终端用户自己在宿主里加的一条 MCP 条目，与技能无关；技能不依赖它、也不去改它。地址就在技能包 `config.local.json` 的 `mcpUrl`——那只是**给人手动查看用的地址来源**，技能代码不读它（别为了让两边一致去改它）。
- 已知限制（要改得在服务端改）：① 只接受服务端配置的固定身份，不接受按传入凭据登录；② 上传没有内容通道（`post_files` 只认文件名）；③ 返回体大、字段要手工投影。

## 随包入口脚本

读写都走**一个**入口脚本 `scripts/zentao.mjs`：换当次令牌 → 经环境变量注入官方禅道 CLI → 由 CLI 取数或写数 → 脚本投影成十几行表格或一行 JSON。禅道列表接口的原始响应是几十 KB 到上百 KB 的 JSON，直接进 Agent 上下文会被截断（实测一次提单据有 8 分钟耗在这上面），所以取值、过滤与投影都在进程内做完，Agent 只拿结论。查重助手 `scripts/zentao-dedupe.mjs` 只负责中文切二元组、生成关键词变体，入口脚本自己会 import 它。

```bash
node <技能目录>/scripts/zentao.mjs products                                   # 当前账号可见的产品（编号、名称、QD；选品范围）
node <技能目录>/scripts/zentao.mjs qd --product 29                            # 产品 QD：账号、姓名、账号状态、最后登录
node <技能目录>/scripts/zentao.mjs projects --product 29                      # 某个产品下面的项目
node <技能目录>/scripts/zentao.mjs bugs --product 29 --match 导出             # 缺陷列表
node <技能目录>/scripts/zentao.mjs feedback --id 421                          # 反馈详情
node <技能目录>/scripts/zentao.mjs dup --kind feedback --product 29 --title "…"  # 查重
node <技能目录>/scripts/zentao.mjs feedback-create --payload-file <路径>       # 建反馈单
node <技能目录>/scripts/zentao.mjs feedback-update --id 421 --payload-file <路径>  # 更新正文
node <技能目录>/scripts/zentao.mjs file-create --file <图片路径> --object-type feedback --object-id 421
```

- **完整清单**：`node <技能目录>/scripts/zentao.mjs --help` 列出全部 13 个子命令与各自认的选项；命令面、字段与错误码见 [zentao-cli.md](zentao-cli.md)。
- **全局旗标也能带**：`--timeout <毫秒>`（单次 HTTP 请求超时）与 `--insecure`（跳过 TLS 证书校验）对**所有子命令**都有效，原样转给官方禅道 CLI；`--timeout` 不是脚本等 CLI 子进程的超时，两者不是一回事。
- **前置**：Node.js 18+（用 `fetch`）与**官方禅道 CLI**（`zentao` 命令，npm 包 `zentao-cli`，版本按 `config.local.json` 的 `zentaoCli`）装好且在 PATH 里。没有 node 或没有 CLI 时如实告诉终端用户并给替代路径（禅道 Web 端自提）；CLI 不在 PATH 时脚本报「找不到 zentao 命令」并退出非 0。
- **凭据**：脚本自己读本机凭据文件并换当前账号的当次令牌，令牌经环境变量注入 CLI 子进程，密码与令牌不打印、不进命令行参数、不进上下文。没写凭据时它会提示去跑 `set-credentials.sh`。
- **地址**：从技能包的 `config.local.json`（`zentaoWebUrl`）读，不回显；交付单据链接时才拼给终端用户。
- **环境变量**（测试用）：`ZENTAO_WEB_URL` 覆盖禅道站点地址（换令牌用），`ZENTAO_CREDENTIALS_FILE` 覆盖凭据文件路径，`ZENTAO_PACKAGE_CONFIG_FILE` 覆盖随包配置路径。
- **写子命令的载荷**：文件里放请求体本身（**不要再套一层 `payload`**），例如 `{"productID": 42, "title": "…", "openedBuild": ["trunk"], "steps": "<正文 HTML>"}`；正文因此不进命令行参数。
- **只发一次**：禅道创建接口没有幂等键，重发会造两条记录。脚本不做重试；写完按返回编号回读核对。
- **缺陷单的负责人由脚本按配置补**（见「默认负责人」）：载荷里没写 `assignedTo` 时，脚本按「终端用户明说 > 本机默认 > 随包默认 > 代码兜底（产品 QD）」解析——随包默认是 `""`（补空串，不指派），`"qd"` 不带这个字段（产品 QD 承接），别的值补该账号。
- **传图**走 `file-create`（官方 CLI 的 `file create`，`multipart/form-data`）：只能挂在已存在的单据上，顺序是「先建单 → 再传图 → 再更新正文」。上限、引用形态与 `--object-type` 的取值见 [zentao-cli.md](zentao-cli.md)「传图」；失败与超时的处理见 [error-handling.md](error-handling.md)「图片上传失败」。
- **为什么不用宿主里的禅道 MCP 工具写**：那些工具的身份是服务端配置的固定账号，单据会留痕在那个账号名下（见下面「禅道 MCP：只给人手动查看」）。

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
  "mcpUrl": "<自研禅道 MCP 地址>"
}
```

- `config.local.json` **进仓库**、随技能包一起分发（见 ADR-0005）。地址本身不是凭据，内网 IP 也不从公网可达。
- 三个字段各管一件事：`zentaoWebUrl` 用于拼单据直达链接（`<zentaoWebUrl>/feedback-view-<反馈 ID>.html`），也是脚本换令牌用的站点地址；`zentaoCli` 是**官方禅道 CLI 的版本锁**（`package` + 固定 `version`），Agent 装 CLI 时只认它，打包脚本把它原样带进包。
- **`mcpUrl` 只是给人看的地址来源**：团队自研的禅道 MCP 已降级为「给人手动查看」，**技能代码不读它、不依赖它、不登记它**（读、写、传图只走官方禅道 CLI）。留着它是让想自己手动登记那条 MCP 的人有个地址可抄，不必到处问。
- **CLI 版本的升级由发版流程显式发起**：改 `zentaoCli.version` → 跑一次接入自检验证 → 重新分发。技能不跟着上游新版自动升级，也不在运行时升级。
- `zentaoWebUrl` 为空或写错：技能仍能提反馈，只是交付时给不了链接，只能给反馈编号——换实例时记得一起改。
- 换成别的禅道实例时，直接改 `config.local.json` 里的地址字段；仓库里没有单独的占位符模板文件。
- 地址用 IP：公司没有内网 DNS 域名可指禅道。IP 随网络调整时改这个文件再分发一次。

### 分发

**发布线只有一条：公网 `skills.sh`。** 一条命令装好（装到所有检测到的 Agent）：

```bash
npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global
```

- 禅道站点地址、禅道 CLI 的版本锁、随包默认产品与负责人都在技能包内的 `config.local.json` 里，随这次分发一起到位。
- 装完就有更新入口：`npx skills check` 看有没有新版，`npx skills update rh-product-feedback` 更新（见上面「重装 / 更新」）。
- 不再维护第二份拷贝渠道（内网包 / NAS / 软件中心推送）：它与 skills.sh 上的内容完全相同，却多出一条必然漂移的发布线。手动拷进机器的目录没有更新入口——跑一次上面那段提示词，Agent 会重新装一份并清掉残留。
