---
name: rh-product-feedback
description: 把自然语言产品反馈落成禅道单据：明确要 Bug 时建正式缺陷单，其余建反馈单；也支持查询进度、补充说明、正文带图。禅道连不上时，能引导你在当前宿主里完成接入与认证。触发场景：「提 Bug / 报缺陷 / 页面报错 / 复现步骤是…」「提需求 / 提建议 / 提交反馈」「查反馈 / 查缺陷 / 看反馈到哪了 / 补充反馈信息」「帮我装禅道 / 连不上禅道」「帮我重装 / 更新一下技能」，或 report a bug、file a feature request、check feedback status、connect zentao；斜杠命令 `/rh-product-feedback install`（pi：`/skill:rh-product-feedback install`）走安装模式。
compatibility: 需要本机 Node.js 18+ 与官方禅道 CLI（npm 包 zentao-cli，固定版本记在 config.local.json 的 zentaoCli），以及本人的禅道账号凭据（见 references/setup.md）。本机没有 Node.js 时由当前 Agent 装（优先用机器上已有的版本管理器，见 setup.md）。
metadata:
  rh-version: "0.13.0"
  rh-channel: cli
---

# rh-product-feedback

把终端用户说出的问题落成禅道里的**单据**，并支持查询、进度解释与补充说明：明确要 **Bug / 缺陷** → **缺陷单**（禅道 `bug` 对象，正式单据，进开发流程）；其余（反馈、需求、建议、说不清是不是 bug）→ **反馈单**（禅道 `feedback` 对象，不进开发流程）。两条路径并存，走缺陷单时**不附带建反馈单**（禅道没有「反馈转缺陷」的关联字段，两张单会变成同一件事的两份记录）。

禅道 CLI 的命令、字段、枚举与错误码以实测为准 → [references/zentao-cli.md](references/zentao-cli.md)。本文件只留路由、写单据的主干与硬约束；模板、话术、错误处理按需下钻。

**终端用户第一次用**：看三步速查——粘提示词、写凭据、验证 → [docs/quick-start.md](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/quick-start.md#三步速查)（给人看的文档，Agent 不用读）。

## 按需读

只读你现在要用的那一份，**不要通读**（每多读一份都是实打实的上下文与时间）：

| 现在要做的事 | 读 |
| --- | --- |
| 提反馈单 | 本文件 + [references/feedback-templates.md](references/feedback-templates.md) |
| 提缺陷单 | 本文件 + [references/bug-templates.md](references/bug-templates.md) |
| 拿话术、输出样例 | [references/workflow.md](references/workflow.md) |
| 装技能 / 装禅道 CLI / 连不上禅道 / 改默认产品 | [references/setup.md](references/setup.md) |
| 报错了、超时了、结果对不上 | [references/error-handling.md](references/error-handling.md) |
| 不确定字段名、枚举、返回结构 | [references/zentao-cli.md](references/zentao-cli.md) |

## 读写都走随包入口脚本

禅道的列表接口一次返回几十 KB 到上百 KB 的 JSON，原始输出进上下文会被截断（实测一次提单据有 8 分钟耗在这上面）。随包的**入口脚本** `scripts/zentao.mjs` 把「换当次令牌 + 调官方禅道 CLI + 过滤与投影」放在进程内做完，Agent 只拿表格与结论；**查重助手** `scripts/zentao-dedupe.mjs` 只做一件事：中文切二元组、生成关键词变体（入口脚本自己会 import 它）。

```bash
node <技能目录>/scripts/zentao.mjs products                        # 当前账号可见的产品（编号、名称、QD）
node <技能目录>/scripts/zentao.mjs qd --product 1                  # 产品 QD：账号、姓名、账号状态、最后登录
node <技能目录>/scripts/zentao.mjs projects --product 29           # 产品的项目
node <技能目录>/scripts/zentao.mjs bugs --product 29 --match 导出   # 缺陷列表（客户端筛选）
node <技能目录>/scripts/zentao.mjs bug --id 1936                   # 缺陷详情
node <技能目录>/scripts/zentao.mjs dup --kind bug --product 29 --title "导出按钮没反应"   # 查重
node <技能目录>/scripts/zentao.mjs bug-create --payload-file /tmp/rh-payload.json  # 建缺陷单
```

- **读写都走这一个入口**：读（产品、项目、列表、详情）、写（建单、更新、传图）、查重都是它的子命令，完整清单与每个子命令认的选项见 `--help`；**只有这一条通道**，不同时并存第二套脚本。
- **不要用宿主里的禅道 MCP 工具写单据**：那个服务端的身份是**服务端配置的固定账号**，经它提交的单据留痕在那个账号名下（见 [references/setup.md](references/setup.md)「禅道 MCP：只给人手动查看」）。
- 脚本自己读本机凭据并换令牌，令牌经环境变量注入官方 CLI 子进程，**密码与令牌不进上下文**；子命令、参数与排错见 [references/setup.md](references/setup.md)「随包入口脚本」。`<技能目录>` 是技能包根目录：pi 在 `~/.agents/skills/rh-product-feedback`，Claude Code 在 `~/.claude/skills/rh-product-feedback`；用 `skills use` 临时跑时是它给的 supporting-files 目录。
- 原始 JSON 不进上下文：列表与详情都在脚本进程里过滤、投影过，Agent 只拿表格与结论。
- 环境里没有 `node` 时没法读写：把「装不了 node」如实告诉终端用户并给替代路径（禅道 Web 端自提），不要退回去用宿主 MCP 工具写单据。

## 术语

- **终端用户与禅道账号**：终端用户是当前对话里提出诉求的那个人；**禅道账号**是他的禅道登录身份，单据留痕在它名下（反馈单的**反馈者** `feedbackBy` 也是他——禅道不自动记录，建单时由入口脚本显式填上）。
- **可见范围**：当前禅道账号能看到的产品的集合；单据只能落在这里面，查重也只覆盖这里面。
- **接入通道**：技能访问禅道的**唯一**路径——官方禅道 CLI（npm 包 `zentao-cli`），替掉了自研的直连实现（见 [ADR-0017](../../docs/adr/0017-用官方禅道CLI替换自研接入通道.md)、[references/zentao-cli.md](references/zentao-cli.md)）。
- **随包脚本**：随技能包分发的脚本只有两件事——**入口脚本** `scripts/zentao.mjs`（读写都走它）与**查重助手** `scripts/zentao-dedupe.mjs`（切词）；`scripts/connect.mjs` 起**本机一次性写入页**，让终端用户自己填账号凭据（`set-credentials.sh` / `.ps1` 是终端兜底，效果一样）。旧的三支脚本（查询器 / 写入脚本 / 上传脚本）已下线。
- **本机写入页**：首次接入时 Agent 起在 `127.0.0.1` 上的一次性表单（`scripts/connect.mjs`），终端用户自己填账号密码或个人令牌，页面当场验证并写本机凭据、写完自关；凭据不经过对话。兜底是终端脚本 `set-credentials.sh` / `.ps1`（见 [ADR-0022](../../docs/adr/0022-写凭据走本机一次性页面.md)）。
- **查重基线**：提单前那次查重扫描到的单据 ID 集合。本次查重同时就是写入的基线——基线之外的编号才可能是本次新建；扫描不完整时基线不算数。
- **随包默认 vs 本机默认**：随包默认写在技能包 `config.local.json`（公司级、所有人共享，用它之前确认一句）；本机默认存在 `preferences.json`（只对本人生效，绝不写进技能包）。默认产品与默认负责人（含产品 QD）都按这两层解析，见 [references/setup.md](references/setup.md)。

## 0. 会话第一步：接入自检

1. **脚本能连上吗**：跑一次 `node <技能目录>/scripts/zentao.mjs products`。成功 → 打印出来的**当前账号可见的产品就是后续选品范围**（选产品、查重、建单都只能落在这里面），直接进终端用户的诉求。失败 → 按 [references/error-handling.md](references/error-handling.md) 处理，并按 [references/setup.md](references/setup.md)「Agent 执行路径」引导：先看禅道 CLI 装没装，再写本机凭据。**不要**向终端用户索要禅道地址、IP、端口或账号密码。
2. **认证由入口脚本做，Agent 不插手**：本机凭据 → 当次禅道令牌 → 经环境变量注入**官方禅道 CLI** → 由 CLI 进程取数并投影，全在 `scripts/zentao.mjs` 进程内完成（见 [references/zentao-cli.md](references/zentao-cli.md)）。Agent 不碰密码与令牌，也不用 curl 调试登录接口（那会把令牌打进终端日志）。凭据无效时脚本报错并退出非 0 → 按 [references/error-handling.md](references/error-handling.md)「认证失败」处理：让终端用户在自己的**本机页面**里重填（跑 `node <技能目录>/scripts/connect.mjs`，**先把地址单独说给他**，再用 `connect.mjs wait` 等结果——两步别串成一条命令，串起来他就看不到地址了），不要在对话里索要密码；连续失败可能触发禅道锁号，不要反复试。
3. **禅道 CLI 不在 PATH**：脚本会如实报「找不到 zentao 命令」并退出非 0——照 [references/setup.md](references/setup.md)「Agent 执行路径」第 1 步按技能包钉住的固定版本把它装好（`config.local.json` 的 `zentaoCli.version`），装完校验版本，不要临时改用旧脚本顶替；**本机没有 Node.js 就由 Agent 装**（优先用机器上已有的版本管理器，没有就装官方的，装完让宿主重开），实在装不上时如实告知并给禅道网页端的替代路径，不退回用宿主里的禅道 MCP 工具建单。
4. **不登记禅道 MCP**：首次接入不需要它（见 [references/setup.md](references/setup.md)「禅道 MCP：只给人手动查看」）。它的身份是**服务端配置的固定身份**，不是提交人自己，所以**只适合无关紧要的查看，不用于建单与更新**；终端用户自己登记过的条目属于他的宿主配置，技能不依赖、也不去改它。**不要为了让两边一致去改技能包里的 `config.local.json`**——那是分发下来的文件，用户没同意不要动。

自检通过就**直接进入终端用户的诉求**（收集要素、查重、草稿），不要插入「自检报告 → 等确认」的往返；只在认证失败、产品不可见时停下来给下一步。

## 1. 路由意图

| 终端用户表达 | 流程 | 落点 |
| --- | --- | --- |
| `/rh-product-feedback install`（pi：`/skill:rh-product-feedback install`）「帮我装 / 装禅道 CLI / 配置 / 连接禅道」「禅道连不上」「帮我重装一下」 | 安装或重装，见 [references/setup.md](references/setup.md) | — |
| 「更新技能」「技能有新版吗」「把 rh-product-feedback 更新一下」「重装一下」 | 重装 / 更新，见 [references/setup.md](references/setup.md) 的「重装 / 更新」——同一段提示词首装和重装都能用，**不要问终端用户现在是哪一版** | — |
| 「提 bug / 报缺陷 / 页面报错 / 崩溃 / 复现步骤是… / 这个功能报错」 | [写单据](#2-写单据反馈单与缺陷单共用一条主干) | 缺陷单 |
| 「提需求 / 需要一个功能 / 希望支持…」「提反馈 / 提建议 / 体验不好 / 建议优化…」 | [写单据](#2-写单据反馈单与缺陷单共用一条主干) | 反馈单（类型：需求 / 建议） |
| 「有个问题 / 不太对劲 / 你看看」 | 追问一次「提反馈单还是直接建缺陷单？」，再进对应流程 | — |
| 「反馈 123 什么状态 / 缺陷 456 谁在处理 / 到哪了 / 为什么还没排期」 | [查询与解释进度](#4-查询与解释进度) | — |
| 「再补充一点 / 又复现了一次 / 补上业务场景」 | [补充说明](#5-补充说明) | — |
| 「修复 xx bug / 把这个 bug 改掉」 | 不属于本技能：这是开发动作，不是产品反馈。说明并指向开发流程 | — |

意图不明时问一句再动手。终端用户明确要「提交」时走提交流程；只描述问题但没说要提交时，先确认意图。**歧义判据**：

- 说的是**产品/系统使用中的不便或期望**（「每次查询都要重选筛选条件」）→ 反馈单，类型 `advice`。
- 说的是**明确的错误现象**（「页面报错」「复现步骤是…」）→ 缺陷单；一句话同时像 Bug 又像需求（「没有这个功能，用起来很难受」）→ 按他表述的**期望**：想要新能力 → 反馈单（类型：需求），现有能力出错 → 缺陷单。
- 明确要改**这个技能本身**（「给这个工具加个记忆功能」）→ 那不是产品反馈，不要在对话里改技能包文件（见硬约束 7），建议他到仓库提 issue。

## 2. 写单据（反馈单与缺陷单共用一条主干）

### 2.1 收集要素

- 必备：标题（一句话说清问题）、所属产品、类型（仅反馈单）、现象或期望、业务场景。
- 缺陷单追加：复现步骤、实际结果、预期结果；建议追加：现状痛点、期望改进。
- 只追问真正影响分类、复现或验收的信息，一次问全；终端用户没说的版本号、模块一律不补写，缺什么就在草稿里写「用户未提供」；负责人按「默认负责人」处理（见 2.5）。
- 追问按模板的「追问格式」呈现（编号、选项字母、建议与理由）：反馈单见 [references/feedback-templates.md](references/feedback-templates.md)，缺陷单见 [references/bug-templates.md](references/bug-templates.md)。
- 给了截图 → 记下图片文件路径，正文按 [6. 正文带图片](#6-正文带图片) 处理。
- 完成标准：模板里每一项都有内容或明确标注缺失。

**所属产品**只能从第 0 步的可见产品里选，优先级：终端用户这次明说的 > 本机默认产品 > 追问一次；缺陷单还多一层随包默认产品，插在本机默认之后、追问之前，用它建单前要确认一句（规则见 [references/setup.md](references/setup.md)「默认产品」）。终端用户说的产品不在可见范围时，如实说明「你的账号看不到 <产品>，这条单暂时提交不到该产品，请找管理员开权限或换一个」，不报「产品不存在」，也不用默认产品顶替。

### 2.2 生成草稿

按模板渲染正文。草稿要能独立读懂——终端用户只看草稿就知道禅道里会存下什么。反馈单正文是纯文本 `desc`；缺陷单正文只有一个载体 `steps`，写成结构化 HTML（模板见 [references/bug-templates.md](references/bug-templates.md)「正文模板」）。

草稿一律给终端用户看**纯文本版**（同样的段落转成 Markdown 列表，不要把 HTML 标签甩给用户）。缺陷单的草稿必须包含这一行声明：「即将创建的是禅道正式缺陷单（会进入开发流程），不是反馈单。」缺陷单草稿的**负责人一栏按生效值具名**：生效值是「不指派」就写「未指派」（随包默认如此，不必查 QD）；生效值是产品 QD 就用入口脚本 `qd --product <产品ID>` 查出来，写「`产品 QD：<账号>（<姓名>）`」，该产品没有 QD 写「未指派（该产品没有 QD）」，查不到就如实说查不到——QD 属于运行时事实，不猜、也不写进技能包；终端用户指名就写他的账号。生效值是产品 QD 时由禅道侧指派，草稿写的是「谁来承接」，回读到的 `assignedTo` 才是生效结果，如实转述。

### 2.3 查重

查重走入口脚本 `node <技能目录>/scripts/zentao.mjs dup --kind <bug|feedback> --product <产品ID> --title "<用户的标题>"`：**匹配一律在客户端做**（禅道服务端会忽略 `filters`，证据见 issue #13）。脚本把标题切成**中文二元组**（英文按词），生成「组内且、组间或」的关键词变体组交给禅道 CLI 匹配——用户说的「切换语言功能失效」能命中禅道里写的「语言切换功能失效」（**词序不同也算重复**），且只在**标题**里匹配，正文里出现的词不算命中。

1. 缺陷单与反馈单各扫一次（`--kind bug` / `--kind feedback`），两边都要给候选；把候选连同 ID、标题、状态、负责人列给终端用户，再按模板的「追问格式」让他选：a. 新建一条 / b. 在 <候选> 上补充 / c. 都不是，并给出建议答案与理由。

这次扫描同时是本次写入的**查重基线**：输出最后一行 JSON 里的 `baseline` 是本次扫描到的全部单据 ID，只有基线里没有的 ID 才可能是本次新建。只覆盖拉取到的范围——说明「**在你可见的 N 条**中未发现重复」，而不是「没有重复」，可见范围由当前账号的禅道权限决定。

### 2.4 用户确认

展示：类型、所属产品、标题、描述全文、查重结果。用户明确确认后才写入。只有「嗯」「行吧」而没看到草稿时，先把草稿给出来再问一次。

### 2.5 创建

写入走随包脚本（**不要调宿主里的禅道 MCP 工具**：它的身份是服务端配置的固定账号，单据会留痕在那个账号名下）。载荷先写进一个临时 JSON 文件，再交给脚本——**正文只走文件，不进命令行参数**；文件里放请求体本身，**不要再套一层 `payload`**。临时文件放本机临时目录（macOS / Linux 用 `/tmp/rh-zentao-payload.json`，Windows 用 `%TEMP%\rh-zentao-payload.json`），用完删掉。

```bash
node <技能目录>/scripts/zentao.mjs feedback-create --payload-file /tmp/rh-zentao-payload.json
node <技能目录>/scripts/zentao.mjs bug-create      --payload-file /tmp/rh-zentao-payload.json
```

```json
{"product": 42, "title": "<标题>", "type": "bug", "desc": "<描述全文>"}
{"productID": 42, "title": "<标题>", "openedBuild": ["trunk"], "severity": 3, "pri": 3, "type": "codeerror", "steps": "<正文 HTML>"}
```

- 缺陷单的 `bug-create` 输出一行 JSON：`{"ok":true,"kind":"bug","id":1945,"title":"…","status":"active","assignedTo":"","assigneeSource":"package","openedBy":"<账号>","url":"<禅道 Web 地址>/bug-view-1945.html","verified":"readback"}`——脚本写完自己按编号回读核对，`verified` 说明结论来自回读（`readback`）还是超时后的查询核实（`query`）；回读对不上 → `ok:false` + `created:true` + `mismatches`，**不要重建**；`uncertain:true` → 按「结果不确定」处理（见 2.6）。
- **只发一次调用**：脚本只发一次请求；禅道创建接口没有幂等键，重发会产生两条记录。
- 字段名与枚举见 [references/zentao-cli.md](references/zentao-cli.md)，两条路径的差异见 [3. 反馈单与缺陷单的差异](#3-反馈单与缺陷单的差异)。
- **缺陷单的负责人按「终端用户明说 > 本机默认 > 随包默认 > 代码兜底」解析**，随包默认是**不指派**（`""`），代码兜底是**产品 QD**。终端用户明说指派给谁 → 载荷写 `assignedTo`；否则**不要写这个字段**，由入口脚本按配置补（`""` 不指派 / `"qd"` 不带该字段、交给产品 QD / 账号名指给该账号）。生效值是产品 QD 时，用 `qd --product <产品ID>` 查承接人（账号、姓名、账号状态），草稿里具名写。配置见 [references/setup.md](references/setup.md)「默认负责人」。
- **反馈单的字段**：`feedbackBy`（反馈者）**由入口脚本显式填当前禅道账号**——这台实例的禅道**不自动记录反馈者**（实测 `feedbackBy` 恒为空），不显式填就永远没有反馈者；`source` / `module` **不填**；`product` 必须写**整数**（字符串形态会被服务端静默忽略）；`desc` 是**纯文本**描述，不写 HTML 标签。反馈单的 `feedback-create` 输出一行 JSON：`{"ok":true,"kind":"feedback","id":421,"title":"…","status":"active","product":42,"type":"bug","feedbackBy":"<账号>","openedBy":"<账号>","submitterField":"openedBy","submitterIsCurrentAccount":true,"url":"<禅道 Web 地址>/feedback-view-421.html","verified":"readback"}`——只发一次，写完自己按编号回读核对（产品、标题、完整正文、反馈者、创建者字段、流水里的「创建」）；`verified` 说明结论来自回读（`readback`）还是超时后的查询核实（`query`）；回读对不上 → `ok:false` + `created:true` + `mismatches`，**不要重建**；`uncertain:true` → 按「结果不确定」处理（见 2.6）。
- 给了截图 → 建单成功后按 [6](#6-正文带图片) 传图并更新正文。

### 2.6 回读校验

用返回的 `id` 调入口脚本 `feedback --id <ID>` / `bug --id <ID>`，核对：产品、标题、完整描述（缺陷单是 `steps`，比较前先剥掉 HTML 标签并归一化换行与空白；图片引用按 `<img fileID="N">` 保留，剥标签不丢它），以及 `actions` 里**本次新增**了 `opened`（历史上存在过不算）；真实 CLI 0.4.4 的 `get` 不返回 `actions` 时，改用 `openedBy` + `openedDate` 核对。缺陷单另核对 `openedBuild`（列表显示「主干」、详情显示 `trunk`，两者指同一个值）与 `severity` / `pri`，以及 `assignedTo` 是否与生效值一致（生效值是产品 QD 时由禅道侧指派：草稿里用 `qd` 查到的是承接人，回读到的 `assignedTo` 才是生效结果，对不上就如实说明——例如账号已锁定——不要改单据）。缺陷单的 `bug-create`、反馈单的 `feedback-create` 已经按返回编号做完这套核对（输出里的 `verified` 说明结论是回读还是查询核实），终端用户要细节时再调入口脚本 `bug --id <ID>` / `feedback --id <ID>`。

任一不一致 → 按 [references/error-handling.md](references/error-handling.md) 处理：先查后报，不重复创建。

**结果不确定时（超时、断连、返回无法解析）**：不重发创建请求。重新扫描该产品，只把「查重基线里没有的 ID + 回读后产品、标题、完整描述都一致 + 有 `opened` 流水（CLI 不返回 `actions` 时用 `openedBy` + `openedDate`）」的候选当作可能的新建：恰好一条 → 按创建成功交付，并说明是查询核实到的；多条 → 报无法唯一确认并列出候选；零条或扫描不完整 → 报未确认，交回终端用户。缺陷单的 `bug-create` 自己就是这么做的（写入前拍一次基线，超时后重查该产品），Agent 只需把输出里的 `uncertain` / `verified` 如实转述。

**响应里没有可解析的业务状态**（HTTP 200 但正文为空、或只回了 JSON-RPC 错误）时，按结果不确定处理。参数错误（JSON-RPC `-32602`，payload 缺必填字段）除外：请求根本没被执行，按失败处理并把服务端的原因告诉终端用户。

### 2.7 交付

给出单据 ID、标题、当前状态、负责人（说清是谁、怎么来的：终端用户指名 / 本机默认 / 随包默认未指派 / 产品 QD）、提交人（当前禅道账号本人）、**禅道直达链接**，以及下一步建议（等待评审 / 需要补充什么信息 / 与哪条既有单重复）。反馈单还要一并说清**反馈者**（`feedbackBy`）与**创建者**（`openedBy`）是不是都是本人。输出样例见 [references/workflow.md](references/workflow.md)。

**链接**：`<禅道 Web 地址>/feedback-view-<反馈 ID>.html` 或 `<禅道 Web 地址>/bug-view-<缺陷 ID>.html`。禅道 Web 地址读技能包内 `config.local.json` 的 `zentaoWebUrl`；读不到或该字段为空 → **不给链接**，只给 ID，并如实说明「技能包里没有配置禅道 Web 地址，给不了直达链接」。不要拿 MCP 地址拼链接，也不要凭印象编一个；给完整 URL，用户点开就能看，不要只写「去禅道看 #421」。

**提交人必须核对**：反馈单与缺陷单都看 `openedBy`（**创建者**字段）——实测这台实例的禅道**不自动记录反馈者**（`feedbackBy` 恒为空），拿它核对会得出「提交人是别人」的错结论；`openedBy` 应当等于当前禅道账号（脚本带的是当前账号的令牌）。反馈者字段 `feedbackBy` 是业务字段，脚本建单时会显式填成当前账号，回读为空也不影响提交人结论。不是本人时，如实说明「禅道里这条单据的提交人是 <另一个人>」——通常是单据走了服务端固定身份那条路（见 [references/setup.md](references/setup.md)「禅道 MCP：只给人手动查看」），不要把服务端的提交人当成终端用户本人。

## 3. 反馈单与缺陷单的差异

| | 反馈单（`feedback`） | 缺陷单（`bug`） |
| --- | --- | --- |
| 产品字段 | `product`（整数） | `productID`（整数） |
| 正文字段 | `desc`（纯文本） | `steps`（结构化 HTML，没有 `desc`） |
| 禅道字段 | `source` / `module` 不填；`feedbackBy`（反馈者）由入口脚本显式填当前禅道账号（禅道不自动记录）；`product` 写整数；`type` 取 `bug` / `story` / `advice` | `severity` 3、`pri` 3、`openedBuild` `["trunk"]`、`execution` 与 `module` 不填——**不追问终端用户**，按 [references/bug-templates.md](references/bug-templates.md) 的「字段默认值」填；他明说的以他说的为准，并在草稿里标出「用户指定」 |
| 项目 | 不挂 | 与产品同名的项目 → 挂它；没有同名项目而可见项目只有一个 `doing` 项目 → 挂它；多个 `doing` 项目且无同名 → 不挂并在草稿注明「未指定项目」；他明说「这是 XX 项目的」→ 挂对应的（先用入口脚本 `projects` 确认存在）。禅道的项目列表不按产品过滤（`project list` 没有按产品筛的选项） |
| 选品 | 本机默认产品一层 | 多一层随包默认产品：用它建单前确认一句「默认记到 <产品名> 对吗？」 |
| 草稿声明 | — | 必须写「即将创建的是禅道正式缺陷单（会进入开发流程），不是反馈单。」 |
| 写入与回读 | 入口脚本 `feedback-create`：只发一次，写完自己按编号回读核对（输出 `feedbackBy` / `openedBy` 与 `verified`） | 入口脚本 `bug-create`：只发一次，写完自己按编号回读核对（输出 `assigneeSource` 与 `verified`） |
| 负责人 | 不指派 | 终端用户明说 > 本机默认 > 随包默认（未指派）> 代码兜底（产品 QD）；交付要说清来源 |
| 附带反馈单 | — | 不附带：禅道没有「反馈转缺陷」的关联字段，一次诉求只建一张单 |

## 4. 查询与解释进度

- **列单据**（一次拉全量 + 字段投影 + 客户端筛选）：`node <技能目录>/scripts/zentao.mjs bugs --product <产品ID> [--status active] [--match 关键词]`；反馈单把 `bugs` 换成 `feedbacks`。脚本用 `--all` 翻完所有页、只留投影字段、在进程内按 `--status` / `--match` 筛，只打十几行表格（默认 10 条，要更多加 `--limit`），原始 JSON 不进上下文。表头的「可见 N 条」是当前账号在这个产品下能看到的全部，不是第一页。
- **打开单据**：给了数字 ID → 缺陷 `bug --id <ID>`，反馈 `feedback --id <ID>`，输出**一行 JSON**：`status`（状态）、`assignee`（负责人）、`processor` + `processedDate`（处理人、处理时间）、`resolution`（结论）、`body`（正文：缺陷单已剥掉标签并归一化空白，可与原文逐字比对；图片引用保留成 `<img fileID="N">`，剥标签不丢它）、`actions`（流水），反馈单另有 `reviewer` / `reviewedDate`。只给了标题或产品 → 先用列表的 `--match` 列候选，让他挑编号再打详情。
- **流水**：`actions` 每条有 `action` / `actor` / `date` / `comment`，`changes` 是这条动作的字段级差异（`field` + `from` → `to`，空值写「（空）」）。回读刚写过的那条单据时，把写前读到的动作 ID 传给 `--baseline-actions 19451,19452`，基线之外的动作才带 `"new": true`；不传基线就没有 `new` 字段——分不出来就说分不出来，不要把历史动作说成本次新增。CLI 0.4.4 的详情不返回 `actions` 时，如实说「这个版本取不到流水」，不要编。
- **三段式解释**，不混写：**事实**（字段与 `actions` 直接给出的东西：谁、何时、把什么改成了什么）→ **推断**（基于事实的判断，每条标注「推断」）→ **无法确定**（禅道里没有的信息）。排期是最常见的坑：`plan` 与 `version` 均为空，只能说「禅道里没有排期记录」，不能写成「产品经理拒绝了需求」——那是推断，且必须写明只是推断。
- **输出格式**：当前状态 / 负责人 / 处理时间线（`actions` 倒序）/ 结论 / 需要补充的信息。话术与样例见 [references/workflow.md](references/workflow.md) 的 F2 / F3。

## 5. 补充说明

禅道没有「只评论不改状态」的接口，关闭、激活、解决会改变单据状态，所以补充说明走**可靠写入路径**：读原文 → 生成追加草稿 → 用户确认 → 写前复核 → 更新 → 回读。逐步话术与草稿样例见 [references/workflow.md](references/workflow.md) 的 F4。

1. **读原文**：入口脚本 `feedback --id <ID>` 取 `desc`；`bug --id <ID>` 取 `steps`。
2. **生成追加草稿**：**原文完整保留**，下面加一行分隔行（14 个 `─`）、标注行「【补充说明 · 日期 · 用户口述，AI 整理】」与追加段落；脚本按分隔行拆草稿，分隔行不能少。
3. **用户确认**：展示完整的新正文（原文 + 分隔行 + 标注 + 追加段落），等他明确确认。
4. **写前复核**：载荷带 `expectedBody`（用户确认时看到的那份原文），脚本写入前再读一次单据核对；对不上就**停手**、不写入，把当前原文与重新合并后的草稿交回终端用户。
5. **更新**：走同一条写入通道（入口脚本，正文只走文件）：`node <技能目录>/scripts/zentao.mjs feedback-update --id <ID> --payload-file /tmp/rh-payload.json`（缺陷单是 `bug-update`）。载荷放请求体本身，不套 `payload`；`expectedBody` 必填。只发一次更新请求。
6. **回读**：脚本按编号回读，正文与**完整预期正文**归一化后逐字比较（缺陷单先剥标签，图片引用按 `fileID` 归一），有 `actions` 时确认这次**新增**了 `edited`（历史上存在过不算证据）；CLI 0.4.4 不返回 `actions`，这时以正文逐字一致为准；结果不明时只读核实，不重放更新，核实不了就报未确认。

禅道更新接口无条件覆盖，没有版本号 CAS：写前复核能降低覆盖别人内容的风险，但复核与写入之间仍可能有别人改过——发现原文变了就停手，把当前原文给终端用户看。

## 6. 正文带图片

禅道正文里的图片是**图片附件**：先上传拿文件标识，再把**图片引用**写进正文。顺序固定：**先建单 → 再传图 → 再更新正文 → 再回读**——上传要带单据类型与单据 ID，图只能挂在已存在的单据上。

1. **传图**：`file-create --file <图片路径> --object-type <bug|feedback> --object-id <单据ID>`，输出文件标识与图片引用。
2. **放引用**：禅道更新接口**无条件覆盖**、没有版本号 CAS，图片只能落在**原文之后的追加段落**里（不是插进正文中间），段落标签按场景写（「截图 1」之类），按 §5 的更新路径写入。
3. **回读**：更新回读通过（完整预期正文 + 本次新增 `edited`），且引用里的文件 ID 与传图返回一致。
4. **失败如实说**：图拿不到就如实说拿不到，不用文字描述假装图已放上去；结果不确定先去单据里看有没有多出附件，**不重复上传**。

步骤与话术见 [references/workflow.md](references/workflow.md) 的 F5；上传通道的事实（单文件上限、引用形态、`--object-type` 的取值）见 [references/zentao-cli.md](references/zentao-cli.md)「传图」；失败与超时的处置见 [references/error-handling.md](references/error-handling.md)「图片上传失败」。

## 硬约束

1. **写入前确认**：所有业务写入都要终端用户明确确认后执行。指派、关闭、删除、解决、重新打开单据由人来做——Agent 只提交内容与读取状态，缺陷单也不流转：**不改变禅道的分配结果**，终端用户明说的负责人写进载荷，其余交给配置（随包默认不指派）。
2. **写只用随包入口脚本**：建单与更新一律走 `scripts/zentao.mjs` 的写子命令（`bug-create` / `feedback-create` / `bug-update` / `feedback-update` / `file-create`），它带当前账号的令牌；宿主里的禅道 MCP 工具是服务端固定身份，不用于写单据。
3. **写入后回读**：按 ID 重新读取并核对内容，「保存成功」的文本不作为落库证据；有 `actions` 时再确认本次**新增**了 `edited` 流水（CLI 0.4.4 不返回 `actions`，这时以正文逐字一致为准）。
4. **不确定先查**：超时、连接中断、返回与预期不符时，先查询核实再决定下一步，同一份内容不重复创建——禅道创建无幂等，盲目重试会造重复单。结果不确定时只认「查重基线之外、唯一、回读完全一致」的新记录；认不准或复查不完整就报未确认交回终端用户，不把「没查到」说成「没创建」。**扫描不完整就不算数**：列表带上「服务端分页未向前推进，覆盖不完整」时，说明只扫到了第 1 页——不能把「在这 N 条里未发现重复」说成「没有重复」，也不能拿这种基线判定新建，如实说「查重覆盖不完整、是否新建未确认」，不重发。
5. **身份**：一切以**当前禅道账号**进行（随包脚本用本机凭据换当前账号的令牌）。说「这是你提交的」只在回读确认**创建者**字段 `openedBy`（反馈单与缺陷单都是它）是当前禅道账号时才能说；反馈者字段 `feedbackBy` 是业务字段，禅道不自动记录它，**不能拿它核对提交人**。提交人是别人时如实说是别人。`openedbyme` 指的是当前禅道账号本人提交的记录。
6. **凭据与地址**：账号、密码、令牌由终端用户本人在**本机一次性页面**（或他自己的终端）写入接入凭据文件——**凭据必须由本人输入**，Agent 不代劳；不在对话里索要、不在回复里回显、不写进任何仓库文件。禅道地址只从 `config.local.json` 读，不主动回显具体值；唯一的例外是 2.7 交付单据链接，那一次给完整 URL。
7. **权限边界**：当前账号看不见的产品与单据就是看不见，不绕过禅道权限去达成写入目的；默认产品不可见时如实说明并指出该找谁开权限，不静默换产品建单。
8. **不改技能包自身的文件**：未经终端用户明确要求修改技能，不动 `SKILL.md`、`references/`、`scripts/`、`config.local.json` 里的任何文件。**唯一例外是重装**：重装流程里删掉「本次更新作废的旧文件」（旧接入通道留下的脚本与参考文档）属于清理残留，不是改技能内容。终端用户把「希望这里能记住上次的筛选条件」这类话说成对产品的期望时，按**给产品的建议**处理（类型 `advice`），不是给技能加功能；真要改技能，请他到仓库提 issue。

## 参考文件

- [references/setup.md](references/setup.md)：连接禅道、写接入凭据、默认产品、各宿主配置、随包入口脚本、**Agent 执行路径**（连不上或要装时读）。
- [references/workflow.md](references/workflow.md)：各流程的完整话术与输出样例（F1 提反馈 / F1b 提缺陷 / F2 查询 / F3 解释进度 / F4 补充说明 / F5 带图）。
- [references/feedback-templates.md](references/feedback-templates.md)：反馈单的起草与追问模板。
- [references/bug-templates.md](references/bug-templates.md)：缺陷单的模板、字段默认值与正文结构。
- [references/zentao-cli.md](references/zentao-cli.md)：禅道 CLI 的命令面、字段与枚举、错误码、版本锁与已知限制。
- [references/error-handling.md](references/error-handling.md)：错误分类、恢复动作与话术。
