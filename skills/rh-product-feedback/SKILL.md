---
name: rh-product-feedback
description: 把自然语言产品反馈落成禅道单据：明确要 Bug 时建正式缺陷单，其余建反馈单；也支持查询进度、补充说明、正文带图。禅道连不上时，能引导你在当前宿主里完成登记与认证。触发场景：「提 Bug / 报缺陷 / 页面报错 / 复现步骤是…」「提需求 / 提建议 / 提交反馈」「查反馈 / 查缺陷 / 看反馈到哪了 / 补充反馈信息」「帮我装禅道 / 连不上禅道」，或 report a bug、file a feature request、check feedback status、connect zentao；斜杠命令 `/rh-product-feedback install`（pi：`/skill:rh-product-feedback install`）走安装模式。
compatibility: 需要本机 node 与禅道账号凭据（见 references/setup.md）；读写经随包脚本直连禅道 MCP，禅道 MCP 服务要可达。
metadata:
  rh-version: "0.11.0"
  rh-mcp-server: zentao
---

# rh-product-feedback

把终端用户说出的问题落成禅道里的**单据**，并支持查询、进度解释与补充说明：明确要 **Bug / 缺陷** → **缺陷单**（禅道 `bug` 对象，正式单据，进开发流程）；其余（反馈、需求、建议、说不清是不是 bug）→ **反馈单**（禅道 `feedback` 对象，不进开发流程）。两条路径并存，走缺陷单时**不附带建反馈单**（禅道没有「反馈转缺陷」的关联字段，两张单会变成同一件事的两份记录）。

禅道 MCP 的工具名、参数包装、字段与枚举以实测为准 → [references/zentao-mcp.md](references/zentao-mcp.md)。本文件只留路由、写单据的主干与硬约束；模板、话术、错误处理按需下钻。

**终端用户第一次用**：看三步速查——粘提示词、写凭据、验证 → [docs/quick-start.md](https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/quick-start.md#三步速查)（给人看的文档，Agent 不用读）。

## 按需读

只读你现在要用的那一份，**不要通读**（每多读一份都是实打实的上下文与时间）：

| 现在要做的事 | 读 |
| --- | --- |
| 提反馈单 | 本文件 + [references/feedback-templates.md](references/feedback-templates.md) |
| 提缺陷单 | 本文件 + [references/bug-templates.md](references/bug-templates.md) |
| 拿话术、输出样例 | [references/workflow.md](references/workflow.md) |
| 装技能 / 连不上禅道 / 登记 MCP / 改默认产品 | [references/setup.md](references/setup.md) |
| 报错了、超时了、结果对不上 | [references/error-handling.md](references/error-handling.md) |
| 不确定字段名、枚举、返回结构 | [references/zentao-mcp.md](references/zentao-mcp.md) |

## 读写都走随包脚本：查询器读、写入脚本写

禅道的列表接口一次返回几十 KB 到上百 KB 的 JSON，原始输出进上下文会被截断（实测一次提单据有 8 分钟耗在这上面）。随包的**查询器**把「取数 + 过滤 + 投影」放在脚本进程内做完，只打印十几行表格；**写入脚本**把「换用户令牌 + 包 payload + 只发一次」也放在进程内做完。

```bash
node <技能目录>/scripts/zentao-query.mjs products --match 报表                            # 可见产品
node <技能目录>/scripts/zentao-query.mjs prep --product 瑞辉智能报表平台 --match 切换语言  # 产品 + 项目 + 查重候选一次给全
node <技能目录>/scripts/zentao-query.mjs bug --id 1936
node <技能目录>/scripts/zentao-write.mjs bug-create --payload-file /tmp/rh-payload.json  # 建缺陷单
```

- **读**（产品、项目、缺陷/反馈列表、单据详情）→ 查询器。**写**（建单、更新）→ 写入脚本，保留用户确认链路。
- **不要用宿主里的禅道 MCP 工具写单据**：实测那个服务端的 `post_users_login` 不校验凭据，恒以服务端配置的固定身份对外服务，经它提交的单据留痕在那个账号名下（见 [references/zentao-mcp.md](references/zentao-mcp.md)）。随包脚本用本机凭据直连禅道换一个**属于当前账号**的令牌，再带着令牌访问禅道 MCP，单据才留痕在提交人自己名下。
- 脚本自己读本机凭据并换令牌，**密码与令牌不进上下文**；子命令、参数与排错见 [references/setup.md](references/setup.md)「禅道查询器」「禅道写入脚本」。`<技能目录>` 是技能包根目录：pi 在 `~/.agents/skills/rh-product-feedback`，Claude Code 在 `~/.claude/skills/rh-product-feedback`；用 `skills use` 临时跑时是它给的 supporting-files 目录。
- 原始 JSON 不进上下文：列表与详情都在脚本进程里过滤、投影过，Agent 只拿表格与结论。
- 环境里没有 `node` 时没法读写：把「装不了 node」如实告诉终端用户并给替代路径（禅道 Web 端自提），不要退回去用宿主 MCP 工具写单据。

## 术语

- **终端用户**：当前对话里提出诉求的那个人；**禅道账号**是他的禅道登录身份（账号名 + 密码或令牌），单据留痕在它名下。
- **可见范围**：当前禅道账号能看到的产品的集合；单据只能落在这里面，查重也只覆盖这里面。
- **随包默认产品**：写在技能包 `config.local.json` 里的公司级默认产品，所有装了这个包的人共享同一份；不是用户自己选的，用它建单前要确认一句。
- **本机默认产品**：终端用户自己设的默认产品，存在他机器的偏好文件 `~/.config/rh-zentao/preferences.json`，只对本人生效，**绝不写进技能包**（那会随包分发给所有人）。
- **查询器**：随包的只读查询脚本（`scripts/zentao-query.mjs`），在进程内过滤禅道数据，只把结果表格交给 Agent。
- **写入脚本**：随包的写单据脚本（`scripts/zentao-write.mjs`），换用户令牌、包 payload、只发一次请求，只把结果 JSON 交给 Agent。
- **用户令牌**：本机凭据换到的、属于当前禅道账号的令牌；随包脚本带着它访问禅道 MCP，单据就留在这个账号名下。
- **草稿**：写库前展示给终端用户确认的结构化内容。
- **回读**：写入后用返回的 ID 重新读取，核对内容与操作流水。

## 0. 会话第一步：环境自检

1. **脚本能连上吗**：跑一次 `node <技能目录>/scripts/zentao-query.mjs products`。成功 → 可见产品就是后续选品的候选范围，直接进终端用户的诉求。失败 → 按 [references/error-handling.md](references/error-handling.md) 处理，并按 [references/setup.md](references/setup.md)「Agent 执行路径」引导：核对地址、写本机凭据。**不要**向终端用户索要禅道地址、IP、端口或账号密码。
2. **地址核对按需触发**：脚本能连上就不用核对；连不上、或走安装流程时，核对一次——`node <技能目录>/scripts/zentao-query.mjs check` 只给结论（一致 / 不一致），不一致就 `sync` 修正（只改 `zentao` 条目的 `url`，写前备份）。当前宿主不是 Claude Code / pi 时加 `--config <宿主 MCP 配置文件>`。**不要为了让两边一致去改技能包里的 `config.local.json`**——那是分发下来的文件，用户没同意不要动。
3. **认证由脚本做，Agent 不插手**：本机凭据 → 禅道用户令牌 → 随令牌访问禅道 MCP，这一步全在脚本进程内完成（见 [references/zentao-mcp.md](references/zentao-mcp.md)）。Agent 不调 `post_users_login`、不碰密码与令牌，也不用 curl 调试登录接口（那会把令牌打进终端日志）。凭据无效时脚本报错并退出非 0 → 按 [references/error-handling.md](references/error-handling.md)「认证失败」处理：让终端用户在自己机器上重写凭据，不要在对话里索要密码；连续失败可能触发禅道锁号，不要反复试。
4. **宿主里的禅道 MCP 工具（可选）**：登记后可以直接调禅道工具，但它们的身份是服务端配置的那个固定账号——**只用于无关紧要的查看，不用于建单与更新**。技能自己的读写一律走随包脚本。
4. **只读自检**：调一次查询器 `products`，确认真的连上了，并用它列出**当前账号可见的产品**——这批产品就是后续选产品的候选范围。失败按 [references/error-handling.md](references/error-handling.md) 处理。

自检通过就**直接进入终端用户的诉求**（收集要素、查重、草稿），不要插入「自检报告 → 等确认」的往返；只在认证失败、产品不可见时停下来给下一步。

## 1. 路由意图

| 终端用户表达 | 流程 | 落点 |
| --- | --- | --- |
| `/rh-product-feedback install`（pi：`/skill:rh-product-feedback install`）「帮我装 / 配置 / 连接禅道」「禅道连不上」 | 安装，见 [references/setup.md](references/setup.md) | — |
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
- 只追问真正影响分类、复现或验收的信息，一次问全；终端用户没说的版本号、模块、负责人一律不补写，缺什么就在草稿里写「用户未提供」。
- 追问按模板的「追问格式」呈现（编号、选项字母、建议与理由）：反馈单见 [references/feedback-templates.md](references/feedback-templates.md)，缺陷单见 [references/bug-templates.md](references/bug-templates.md)。
- 给了截图 → 记下图片文件路径，正文按 [6. 正文带图片](#6-正文带图片) 处理。
- 完成标准：模板里每一项都有内容或明确标注缺失。

**所属产品**只能从第 0 步的可见产品里选，优先级：终端用户这次明说的 > 本机默认产品 > 追问一次；缺陷单还多一层随包默认产品，插在本机默认之后、追问之前，用它建单前要确认一句（规则见 [references/setup.md](references/setup.md)「默认产品」）。终端用户说的产品不在可见范围时，如实说明「你的账号看不到 <产品>，这条单暂时提交不到该产品，请找管理员开权限或换一个」，不报「产品不存在」，也不用默认产品顶替。

### 2.2 生成草稿

按模板渲染正文。草稿要能独立读懂——终端用户只看草稿就知道禅道里会存下什么。反馈单正文是纯文本 `desc`；缺陷单正文只有一个载体 `steps`，写成结构化 HTML（模板见 [references/bug-templates.md](references/bug-templates.md)「正文模板」）。

草稿一律给终端用户看**纯文本版**（同样的段落转成 Markdown 列表，不要把 HTML 标签甩给用户）。缺陷单的草稿必须包含这一行声明：「即将创建的是禅道正式缺陷单（会进入开发流程），不是反馈单。」

### 2.3 查重

禅道 MCP 没有服务端关键词检索，查重靠客户端匹配：

1. 查询器 `bugs --product <产品ID> --match <关键词>` 与 `feedbacks --product <产品ID> --match <关键词>`（关键词取标题里有区分度的词），同一产品一次查完两处；`prep` 可一次给全产品、项目与候选。
2. 把候选连同 ID、标题、状态、负责人列给终端用户，再按模板的「追问格式」让他选：a. 新建一条 / b. 在 <候选> 上补充 / c. 都不是，并给出建议答案与理由。

这次扫描同时是本次写入的**查重基线**：结果不确定时，只有基线里没有的 ID 才可能是本次新建。只覆盖拉取到的范围——说明「**在你可见的 N 条**中未发现重复」，而不是「没有重复」，可见范围由当前账号的禅道权限决定。

### 2.4 用户确认

展示：类型、所属产品、标题、描述全文、查重结果。用户明确确认后才写入。只有「嗯」「行吧」而没看到草稿时，先把草稿给出来再问一次。

### 2.5 创建

写入走随包的写入脚本（**不要调宿主里的禅道 MCP 工具**：它的身份是服务端配置的固定账号，单据会留痕在那个账号名下）。先把 payload 内容写进一个临时 JSON 文件，再调脚本；载荷文件里放 payload 的内容本身，**不要再套一层 `payload`**。

```bash
node <技能目录>/scripts/zentao-write.mjs feedback-create --payload-file /tmp/rh-payload.json
node <技能目录>/scripts/zentao-write.mjs bug-create      --payload-file /tmp/rh-payload.json
```

```json
{"product": 42, "title": "<标题>", "desc": "<描述全文>", "type": "bug"}
{"productID": 42, "title": "<标题>", "openedBuild": ["trunk"], "severity": 3, "pri": 3, "type": "codeerror", "steps": "<正文 HTML>"}
```

- 脚本输出一行 JSON：`{"ok":true,"kind":"bug-create","id":"1945","status":"success","message":"保存成功"}`。`ok:false` → 按失败处理，并把 `message` 里的服务端原因告诉终端用户；`uncertain:true` → 按「结果不确定」处理（见 2.6）。
- **只发一次调用**：脚本只发一次请求；禅道创建接口没有幂等键，重发会产生两条记录。
- 字段名与枚举见 [references/zentao-mcp.md](references/zentao-mcp.md)，两条路径的差异见 [3. 反馈单与缺陷单的差异](#3-反馈单与缺陷单的差异)。
- 不填 `assignedTo`：指派由人决定。
- `source` / `module` / `feedbackBy` 保持不填：反馈者由禅道按当前禅道账号自动记录，填了反而与实际留痕矛盾。
- 给了截图 → 建单成功后按 [6](#6-正文带图片) 传图并更新正文。

### 2.6 回读校验

用返回的 `id` 调查询器 `feedback --id <ID>` / `bug --id <ID>`（**不要用 `get_issues_issueID`**——它解析不了缺陷 ID），核对：产品、标题、完整描述（缺陷单是 `steps`，比较前先剥掉 HTML 标签并归一化换行与空白），以及 `actions` 里**本次新增**了 `opened`（历史上存在过不算）。缺陷单另核对 `openedBuild`（列表显示「主干」、详情显示 `trunk`，两者指同一个值）与 `severity` / `pri`。

任一不一致 → 按 [references/error-handling.md](references/error-handling.md) 处理：先查后报，不重复创建。

**结果不确定时（超时、断连、返回无法解析）**：不重发创建请求。重新扫描该产品，只把「查重基线里没有的 ID + 回读后产品、标题、完整描述都一致 + 有 `opened` 流水」的候选当作可能的新建：恰好一条 → 按创建成功交付，并说明是查询核实到的；多条 → 报无法唯一确认并列出候选；零条或扫描不完整 → 报未确认，交回终端用户。

**响应里没有可解析的业务状态**（HTTP 200 但正文为空、或只回了 JSON-RPC 错误）时，按结果不确定处理。参数错误（JSON-RPC `-32602`，payload 缺必填字段）除外：请求根本没被执行，按失败处理并把服务端的原因告诉终端用户。

### 2.7 交付

给出单据 ID、标题、当前状态、负责人（没有则说明尚未指派）、提交人（当前禅道账号本人）、**禅道直达链接**，以及下一步建议（等待评审 / 需要补充什么信息 / 与哪条既有单重复）。输出样例见 [references/workflow.md](references/workflow.md)。

**链接**：`<禅道 Web 地址>/feedback-view-<反馈 ID>.html` 或 `<禅道 Web 地址>/bug-view-<缺陷 ID>.html`。禅道 Web 地址读技能包内 `config.local.json` 的 `zentaoWebUrl`；读不到或该字段为空 → **不给链接**，只给 ID，并如实说明「技能包里没有配置禅道 Web 地址，给不了直达链接」。不要拿 MCP 地址拼链接，也不要凭印象编一个；给完整 URL，用户点开就能看，不要只写「去禅道看 #421」。

**提交人必须核对**：反馈单看 `feedbackBy`，缺陷单看 `openedBy`；它应当等于当前禅道账号（写入脚本带的是当前账号的令牌）。不是本人时，如实说明「禅道里这条单据的提交人是 <另一个人>」——通常是单据走了服务端固定身份那条路（见 [references/zentao-mcp.md](references/zentao-mcp.md)），不要把服务端的提交人当成终端用户本人。

## 3. 反馈单与缺陷单的差异

| | 反馈单（`feedback`） | 缺陷单（`bug`） |
| --- | --- | --- |
| 产品字段 | `product`（整数） | `productID`（整数） |
| 正文字段 | `desc`（纯文本） | `steps`（结构化 HTML，没有 `desc`） |
| 禅道字段 | 不填 `source` / `module` / `feedbackBy`；`type` 取 `bug` / `story` / `advice` | `severity` 3、`pri` 3、`openedBuild` `["trunk"]`、`execution` 与 `module` 不填——**不追问终端用户**，按 [references/bug-templates.md](references/bug-templates.md) 的「字段默认值」填；他明说的以他说的为准，并在草稿里标出「用户指定」 |
| 项目 | 不挂 | 与产品同名的项目 → 挂它；没有同名项目而可见项目只有一个 `doing` 项目 → 挂它；多个 `doing` 项目且无同名 → 不挂并在草稿注明「未指定项目」；他明说「这是 XX 项目的」→ 挂对应的（先用查询器 `projects` 确认存在）。禅道的项目列表不按产品过滤（`get_projects` 传 `productID` 也返回全部可见项目） |
| 选品 | 本机默认产品一层 | 多一层随包默认产品：用它建单前确认一句「默认记到 <产品名> 对吗？」 |
| 草稿声明 | — | 必须写「即将创建的是禅道正式缺陷单（会进入开发流程），不是反馈单。」 |
| 附带反馈单 | — | 不附带：禅道没有「反馈转缺陷」的关联字段，一次诉求只建一张单 |

## 4. 查询与解释进度

- **定位**：给了数字 ID → 缺陷用 `bug --id <ID>`，反馈用 `feedback --id <ID>`；描述产品或标题 → 查询器 `bugs` / `feedbacks --product <ID> --match <关键词>` 客户端匹配后列候选让他选，并指出最相近的那条作为建议。
- **读事实**：取状态、负责人、处理人/处理时间、评审人/评审时间、结论、解决方案，以及 `actions[]`（`action` / `actor` / `comment` / `date`）与其中的 `history[]`（字段级差异）。`actions[]` 与 `actions[].history[]` 运行时才返回，工具的 Schema 里没有声明，按运行时数据读。字段清单见 [references/zentao-mcp.md](references/zentao-mcp.md)。
- **三段式解释**，不混写：**事实**（直接来自字段与 `actions[]` 的陈述：谁、何时、把什么改成了什么）→ **推断**（基于事实的判断，每条标注「推断」）→ **无法确定**（接口里没有的信息，如未排期原因）。例：`plan` 与 `version` 均为空，只能说明「禅道里没有排期记录」，不能等同于「产品经理拒绝了需求」——后者是推断，且必须写明它只是推断。
- **输出格式**：当前状态 / 负责人 / 处理时间线（`actions` 倒序）/ 结论 / 需要补充的信息。话术与样例见 [references/workflow.md](references/workflow.md) 的 F2 / F3。

## 5. 补充说明

禅道没有「只评论不改状态」的接口，关闭、激活、解决会改变单据状态，所以补充说明走**可靠写入路径**：读原文 → 生成追加草稿 → 用户确认 → 写前复核 → 更新 → 回读。逐步话术与草稿样例见 [references/workflow.md](references/workflow.md) 的 F4。

1. **读原文**：查询器 `feedback --id <ID>` 取 `desc`；`bug --id <ID>` 取 `steps`。
2. **生成追加草稿**：原文完整保留，下方追加分隔行与追加段落，标注追加时间与「用户口述，AI 整理」。
3. **用户确认**：展示完整的新正文（原文 + 追加段）。
4. **写前复核**：确认之后、写入之前再读一次同一条单据，核对产品、标题、原始正文是否仍与生成草稿时一致。被别人改过 → 停止写入，把当前原文与重新合并后的草稿交给终端用户确认。
5. **更新**：走写入脚本（反馈 `feedback-update`、缺陷 `bug-update`，都带 `--id`）：`node <技能目录>/scripts/zentao-write.mjs feedback-update --id <ID> --payload-file /tmp/rh-payload.json`。反馈的 payload 带 `product` 数字、`title` 沿用原值、`desc` 新值（`product` 传字符串会被服务端静默忽略）；缺陷的 payload 带 `productID` 数字、`title` 沿用原值、`steps` 新值。只发一次更新请求。
6. **回读**：正文与**完整预期正文**归一化后逐字比较（缺陷单先剥标签），并确认 `actions` 这次**新增**了 `edited`（历史上存在过 `edited` 不算证据）；结果不明时只读核实，不重放更新，核实不了就报未确认交回终端用户。

禅道更新接口无条件覆盖，没有版本号 CAS：写前二次回读能显著降低覆盖别人内容的风险，但复核与写入之间仍可能有别人改过——发现原文变了就停手。

## 6. 正文带图片

禅道正文里的图片是禅道里的**图片附件**：先上传拿到文件标识，再在正文里放一个**图片引用**。禅道 MCP 没有上传通道（`post_files` 只接受文件名），所以走随包的上传脚本，它直连禅道 REST v2；顺序固定：**先建单 → 再传图 → 再更新正文**（禅道上传要带单据类型与单据 ID，图片只能挂在已存在的单据上）。

```bash
node <技能目录>/scripts/zentao-upload.mjs --file <图片路径> --object-type feedback --object-id <反馈 ID>
```

缺陷单把 `--object-type` 换成 `bug`。脚本输出文件标识与图片引用，并自己回读字节核对过。

引用固定形态（相对路径；`t` 是扩展名、小写、不带点；不用 base64 内联）与边界（图片拿不到、传图失败、几张图怎么挂、删除单据时的清理）见 [references/workflow.md](references/workflow.md) 的 F5 与 [references/error-handling.md](references/error-handling.md)「图片上传失败」。上传失败就如实说失败，不改用文字描述假装图片已经放上去。

## 硬约束

1. **写入前确认**：所有业务写入都要终端用户明确确认后执行。指派、关闭、删除、解决、重新打开单据由人来做——Agent 只提交内容与读取状态，缺陷单也不做流转。
2. **写只用随包写入脚本**：建单与更新一律走 `scripts/zentao-write.mjs`，它带当前账号的令牌；宿主里的禅道 MCP 工具是服务端固定身份，不用于写单据。
3. **写入后回读**：按 ID 重新读取并核对内容，「保存成功」的文本不作为落库证据；补充说明还要确认本次**新增**了 `edited` 流水。
4. **不确定先查**：超时、连接中断、返回与预期不符时，先查询核实再决定下一步，同一份内容不重复创建——禅道创建无幂等，盲目重试会造重复单。结果不确定时只认「查重基线之外、唯一、回读完全一致」的新记录；认不准或复查不完整就报未确认交回终端用户，不把「没查到」说成「没创建」。
5. **身份**：一切以**当前禅道账号**进行（随包脚本用本机凭据换当前账号的令牌）。说「这是你提交的」只在回读确认提交人（`feedbackBy` / `openedBy`）是当前禅道账号时才能说；提交人是别人时如实说是别人。`openedbyme` 指的是当前禅道账号本人提交的记录。
6. **凭据与地址**：账号、密码、令牌由终端用户本人在自己的机器上写入接入凭据文件——**凭据必须由本人输入**，Agent 不代劳；不在对话里索要、不在回复里回显、不写进任何仓库文件。禅道地址只从 `config.local.json` 读，不主动回显具体值；唯一的例外是 2.7 交付单据链接，那一次给完整 URL。
7. **权限边界**：当前账号看不见的产品与单据就是看不见，不绕过禅道权限去达成写入目的；默认产品不可见时如实说明并指出该找谁开权限，不静默换产品建单。
8. **不改技能包自身的文件**：未经终端用户明确要求修改技能，不动 `SKILL.md`、`references/`、`scripts/`、`config.local.json` 里的任何文件。终端用户把「希望这里能记住上次的筛选条件」这类话说成对产品的期望时，按**给产品的建议**处理（类型 `advice`），不是给技能加功能；真要改技能，请他到仓库提 issue。

## 参考文件

- [references/setup.md](references/setup.md)：连接禅道、写接入凭据、默认产品、各宿主配置、查询器与写入脚本、**Agent 执行路径**（连不上或要装时读）。
- [references/workflow.md](references/workflow.md)：各流程的完整话术与输出样例（F1 提反馈 / F1b 提缺陷 / F2 查询 / F3 解释进度 / F4 补充说明 / F5 带图）。
- [references/feedback-templates.md](references/feedback-templates.md)：反馈单的起草与追问模板。
- [references/bug-templates.md](references/bug-templates.md)：缺陷单的模板、字段默认值与正文结构。
- [references/zentao-mcp.md](references/zentao-mcp.md)：工具映射、`payload` 包装、字段与枚举、实测坑。
- [references/error-handling.md](references/error-handling.md)：错误分类、恢复动作与话术。
