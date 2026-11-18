# 禅道 MCP 工具映射（实测）

本文只覆盖 `rh-product-feedback` 实际调用的工具。全部结论来自仓库 Issue #1 的实测试证 + 线上复核。
工具总数 121 个（`serverInfo.name = zentao`），本文不复制全部 Schema——按需读本文即可。

## 接入与认证

- 接入方式：Streamable HTTP MCP（HTTP POST + SSE 响应）。
- 工具名前缀随宿主而异：有的宿主暴露 `post_feedbacks`，有的暴露 `mcp__zentao__post_feedbacks`。用宿主实际暴露的名字。
- **每个会话先登录一次**：`post_users_login`，参数包在 `payload` 内 `{"payload": {"account": "...", "password": "..."}}`。
  - 账号是**用户本人的禅道账号**，凭据来自本机接入凭据文件（见 [setup.md](setup.md)）；不要在对话里索要密码或令牌。
  - 未登录时所有数据调用返回 **HTTP 401**。
  - 登录返回的 `user` 是该账号本人；所有工具入参都没有 `user` / `account` 参数——**当前会话的身份在登录时确定，之后所有操作都以它进行**。
  - 账号通常是 `admin=false` 的普通用户权限：可见的产品、项目、反馈因人而异，见下文「权限随账号」。

### 实测偏差（2026-11-17 复核，与上面的描述不一致）

在真实禅道 MCP 上直接验证，发现当前实现与上文两处描述不符：

| 验证项 | 实测结果 |
| --- | --- |
| 不调用 `post_users_login`，直接调 `get_products` | **HTTP 200**，正常返回 18 个产品（不是 401） |
| `post_users_login` 传**真实账号** | `status: success`，返回 `user` = 服务端身份 |
| `post_users_login` 传**不存在的账号** | `status: success`，返回**同一个** `user` |
| `post_users_login` 传**空账号空密码** | `status: success`，返回**同一个** `user` |

即：**当前 MCP 的登录接口不校验传入凭据，恒以服务端配置的一个固定身份对外服务**。后果：

- 「每用户独立账号、反馈留痕在提交人名下」目前**无法由客户端保证**——所有经该 MCP 提交的反馈都留痕在同一个服务端账号名下。
- 「登录失败」这个分支目前**触发不了**：认证失败、账号被锁定这些错误不会以登录失败的形式出现。
- 技能侧仍然会读取本机凭据文件并发起登录（凭据暴露面照旧存在），但那一步并不决定操作身份。

这是禅道 MCP 侧的问题，已另开 issue 跟踪；技能侧的对策是：回读时核对 `feedbackBy`，与当前登录账号不一致就如实告诉用户「这条反馈的提交人是 <另一个人>」，不要把服务端的提交人当成用户本人。

## 参数包装：`payload` 不可省

创建 / 更新类工具的参数**必须包在 `payload` 对象内**：

```json
{"payload": {"product": 42, "title": "...", "desc": "..."}}
```

按扁平形式（`{"product": 42, "title": "..."}`）调用会被服务端**静默忽略**，表现为业务报错（例如「『反馈名称』不能为空。」），而不是参数错误。宿主把 Schema 展平显示时尤其容易踩这个坑——**以调用结果为准，不要以 Schema 显示形态为准**。

读取类工具（`get_*`）不需要包装；`get_feedbacks_feedbackID` 的 ID 直接放在顶层。

## 本技能调用的工具

| 用途 | 工具 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| 登录 | `post_users_login` | `payload.account`、`payload.password` | `status`、`token`（输出里是占位符）、`user` |
| 产品列表 | `get_products` | `pageID`、`recPerPage`、`orderBy` | `products[]` + `pager` |
| 项目列表 | `get_projects` | `pageID`、`recPerPage` | `projects[]` + `pager` |
| 用户列表 | `get_users` | `pageID`、`recPerPage`、`browseType` | `users[]` + `pager` |
| 产品反馈列表 | `get_products_productID_feedbacks` | `productID`、`browseType`、`orderBy`、`pageID`、`recPerPage` | `feedbacks[]` + `pager` |
| 反馈详情 | `get_feedbacks_feedbackID` | `feedbackID` | `feedback{...}` + **`actions[]`** + `status` |
| 创建反馈 | `post_feedbacks` | `payload.product`（整数，必填）、`payload.title`（必填）、`payload.desc`、`payload.type` | `id`、`message`、`status` |
| 更新反馈 | `put_feedbacks_feedbackID` | `feedbackID` + `payload.product`、`payload.title`（两者必填，沿用原值）、`payload.desc` | `id`、`message`、`status` |
| 删除反馈 | `delete_feedbacks_feedbackID` | `feedbackID` | `message`、`status`（仅在明确授权的测试数据上使用） |
| 交叉读取 | `get_bugs_bugID`、`get_stories_storyID`、`get_issues_issueID` | 各自 ID | 见下方「Bug 不要用统一 issue 视图」 |

## 读列表：用查询器，不要直调

列表类接口的单次响应很大（实测：18 个产品 = 25KB，29 个项目 = 87KB），直接进 Agent 上下文会被截断。**列表与详情一律走随包的查询器** `scripts/zentao-query.mjs`（见 [setup.md](setup.md)「禅道查询器」），它把取数、过滤、投影放在脚本进程内做完，只打印十几行表格。

直调这些接口时（查询器内部也适用）有四个实测坑：

1. **分页参数必须是字符串**：`recPerPage` / `pageID` 传数字会被服务端以 `-32602` 拒掉（`type: 100 has type "integer", want "string"`）。宿主 MCP 客户端会替我们转，直连 HTTP 不会。
2. **服务端不认筛选参数**：`get_products` 传 `name`、`get_projects` 传 `status` 都被忽略，返回的还是全量。筛选必须在客户端做。
3. **`get_projects` 不按产品过滤**：传不传 `productID` 返回同一批项目（实测 29 个）。选项目要自己在客户端挑（同名项目优先）。
4. **`id` 的类型不稳定**：产品列表里是数字（`29`），项目与缺陷详情里是字符串（`"142"`）。比较 ID 用宽松相等。

关键词匹配也在客户端做：查询器把中文标题切成二元组、英文按词，算「查询词被标题覆盖的比例」——中文语序与口语常常不同（用户说「切换语言功能失效」，标题写「语言切换功能失效」），整串包含匹配会漏。

## 缺陷单相关（实测）

### 工具

| 用途 | 工具 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| 产品缺陷列表 | `get_products_productID_bugs` | `productID`、`pageID`、`recPerPage` | `bugs[]` + `pager` |
| 缺陷详情 | `get_bugs_bugID` | `bugID` | `bug{...}` + 顶层 **`actions[]`** + `status` |
| 创建缺陷 | `post_bugs` | `payload.productID`（整数，必填）、`payload.title`（必填）、`payload.openedBuild`（字符串数组，必填）、`payload.steps`、`payload.severity`、`payload.pri`、`payload.type`、`payload.project`、`payload.execution` | `id`、`message`、`status` |
| 更新缺陷 | `put_bugs_bugID` | `bugID` + `payload.productID`、`payload.title`、`payload.steps` | `id`、`message`、`status` |
| 删除缺陷 | `delete_bugs_bugID` | `bugID` | `message`、`status`（仅在明确授权的测试数据上使用） |
| 项目列表 | `get_projects` | `pageID`、`recPerPage` | `projects[]` + `pager` |
| 项目下的版本 | `get_projects_projectID_builds` | `projectID` | `builds[]`（`branch` 为 `0` 即主干分支） |

### 三个必须记住的坑

1. **字段名是 `productID`，不是 `product`**：反馈单用 `payload.product`，缺陷单用 `payload.productID`。`productID` 在工具 schema 里是必填，传错字段名会被 MCP 的参数校验拦下（JSON-RPC `-32602`，`missing properties: [productID]`），请求根本没执行；只有当 `payload` 整个缺失（传了扁平参数）时，才会落到禅道自己的业务校验、报『所属产品』不能为空。
2. **`openedBuild` 是必填的字符串数组**：这台实例的主干值是 `trunk`——缺陷列表视图显示「主干」，详情视图显示 `trunk`，指同一个值，比较时要归一化。
3. **`steps` 是富文本 HTML**：禅道存的是 HTML，裸 `\n` 会被压掉；正文按段落写 `<p>`，回读比较前先剥标签再归一化空白。

### 枚举

`post_bugs` 的 `payload.type`：`codeerror`（代码错误）｜`config`（配置相关）｜`install`（安装部署）｜`security`（安全相关）｜`performance`（性能问题）｜`standard`（标准规范）｜`automation`（测试脚本）｜`designdefect`（设计缺陷）｜`others`（其他）。线上数据里出现过枚举外的值（如 `codeimprovement`），**只用上面这些**。

`severity` / `pri` 默认都是 `3`。

### 线上真实缺陷的字段分布（抽样 100 条，决定默认值）

| 字段 | 分布 | 技能的处理 |
| --- | --- | --- |
| `severity` | `3` 占 82% | 默认 3 |
| `pri` | `3` 占 82% | 默认 3 |
| `execution` | `0` 占 99% | 不挂执行 |
| `project` | 有值占 94%（集中在少数几个项目） | 优先挂与产品同名的项目；否则只有一个 doing 项目时挂它，多个则不挂并注明 |
| `module` | `0` 占 97% | 不设（MCP 也没有这个参数） |
| `openedBuild` | 主干占 82% | 默认 `["trunk"]` |
| `type` | `codeerror` 占 90% | 按描述归类，拿不准用 `others` |
| `assignedTo` | 99% 都有值 | 指派归人（技能不做指派） |

### 缺陷详情的 `actions[]`

与反馈单一样，`get_bugs_bugID` 的响应顶层有 `actions[]`（`action` / `actor` / `comment` / `date`），新建后应出现 `opened`。

## 反馈详情里读什么

`get_feedbacks_feedbackID` 返回的 `feedback` 对象常用字段：

| 字段 | 含义 |
| --- | --- |
| `id` / `title` / `desc` | 编号、标题、描述正文（`desc` 回读时换行是 `\r\n`） |
| `product` | 所属产品 ID（回读是字符串形式，更新时要转成数字） |
| `status` / `subStatus` | 状态与子状态（新建反馈为 `wait`） |
| `feedbackBy` | 反馈者：当前登录账号本人 |
| `assignedTo` | 负责人（未指派时为空） |
| `processedBy` / `processedDate` | 处理人、处理时间 |
| `reviewedBy` / `reviewedDate` | 评审人、评审时间 |
| `result` / `solution` / `faq` | 处理结论、解决方案、常见问题 |
| `repeatFeedback` | 是否重复反馈 |
| `keywords` | 关键词（查重时可一并匹配） |
| `files` | 附件（只读；上传不可用） |

**`actions[]`（运行时才返回，Schema 未声明）**：操作流水，每条含 `action`（`opened` / `edited` / `closed` / `resolved` 等）、`actor`、`comment`、`date`。它与 `feedback` 同级出现在响应顶层。用它在时间线上还原「谁在何时做了什么」。

**`actions[].history[]`（字段级差异）**：改字段后出现在对应动作里，含 `field`、`diff`、`new`、`old`。注意字段名是 `new` / `old`，不是 `newValue` / `oldValue`。

## 回读时的两个坑（实测）

1. **换行会被规范化**：描述里的 `\n` 存进去，回读是 `\r\n`。比较前后先归一化换行符，否则会误判成「没写进去」。
2. **`product` 必须是数字**：更新反馈时 `payload.product` 传字符串（如 `"42"`）会被服务端**静默忽略**——返回「保存成功」但描述没变、`actions` 也没有 `edited`。这是典型的静默失败，只有回读能发现。

## 枚举

`post_feedbacks` 的 `payload.type` 取值（来自工具描述）：

`story` 需求 ｜ `task` 任务 ｜ `bug` Bug ｜ `todo` 待办 ｜ `advice` 建议 ｜ `issue` 问题 ｜ `risk` 风险 ｜ `opportunity` 机会

本技能只使用三个：`bug`（Bug）、`story`（需求）、`advice`（建议）。

`get_products_productID_feedbacks` 的 `browseType` 可选：`wait`、`doing`、`toclosed`、`review`、`assigntome`、`openedbyme`。查重时用默认范围（不传）以覆盖全部反馈；`openedbyme` 指的是**当前登录账号**本人提交的记录。

## 已知限制（实测结论）

| 限制 | 影响 | 本技能的处理 |
| --- | --- | --- |
| 无服务端关键词检索 | 121 个工具入参没有 `keyword` / `search` / `query`；传入会被静默忽略 | 查重改为查询器分页拉取 + 客户端匹配，并如实说明覆盖范围 |
| 创建接口无幂等 | 同一 payload 连续两次产生两个不同 id、两条记录 | 写前查重；结果不确定时先查再决定，不盲目重试 |
| 附件上传不可用 | `post_files` 以不同扩展名调用均返回「文件上传失败，文件格式不在规定范围内」 | 明确告知不支持，请用户走禅道 Web 端上传 |
| 没有「只评论不改状态」的工具 | 只能改字段或走状态流转 | 补充说明走 `put_feedbacks_feedbackID` 改 `desc` |
| 状态流转可能静默 no-op | 反馈 `activate` 返回「保存成功」但状态与 `actions` 无变化 | 补充说明不使用流转接口；任何写入都回读校验 |
| 枚举几乎不校验 | `openedBuild`、`resolution` 传任意字符串都「保存成功」并入库 | 本技能不写这两类字段；需要归属字段时先与用户确认 |
| Schema 与运行时不一致 | `post_stories` 的 `reviewer`、`post_tickets` 的 `module` 实际必填；`post_requirements` 不返回 `id` | 不按 Schema 判断字段存在与否；关键字段按运行时读取 |
| 权限随账号 | 每个用户用自己的账号登录，能看到的产品、项目、反馈都不同；看不见不等于不存在 | 只在可见范围内选品与查重，如实说明覆盖范围；用户提到的产品不可见时提示找管理员开权限 |
| 登录失败会锁号 | 连续登录失败可能触发禅道账号锁定 | 登录失败只重试一次就停，不反复试；提示用户去禅道解锁 |
| 无「反馈转 Bug/需求」工具 | `post_bugs` 的 `payload` 不接收来源反馈 ID | 缺陷单与反馈单之间没有自动转换：用户明确要缺陷单时直接建缺陷单，不附带建反馈单（见 ADR-0008） |
| 附件上传没有内容通道 | `post_files` 的 payload 只有 `fileName`，没有内容字段；`delete_files_fileID` 存在但没有对应的上传通道 | 明确告知不支持图片，请用户贴文字或走禅道 Web 端（仓库 issue #8 跟踪） |

## Bug 不要用统一 issue 视图

`get_issues_issueID` 能解析需求、反馈、任务类 ID，但**解析不了 Bug ID**（会得到「对象不存在」式提示）。涉及 Bug 的读取一律用 `get_bugs_bugID`。

## 响应解析

工具返回的文本内容通常是 `HTTP <状态码>` 一行 + JSON 正文，例如：

```
HTTP 200
{"id": 123, "status": "success", "message": "保存成功"}
```

宿主若另给 `structuredContent`，优先读它。业务失败同样是 HTTP 200，但正文里 `status` 为 `fail`——**判断成功要看 `status` 字段，不要看 HTTP 码，也不要看「保存成功」文案**。
