# 禅道 CLI（接入通道）

技能的默认接入通道是**官方禅道 CLI**（npm 包 `zentao-cli`，可执行文件 `zentao`）。随包入口脚本 `scripts/zentao.mjs` 把三件事包在进程内做完：读本机凭据换当次令牌 → 以环境变量注入 CLI 子进程 → 调 CLI 取数并投影成紧凑表格。Agent 只见投影后的结果，原始 JSON 不进上下文。

本文件是命令、字段、枚举与错误码的参考；话术与输出样例见 [workflow.md](workflow.md)，错误的四类分流与下一步见 [error-handling.md](error-handling.md)。

## 认证

- 环境凭据：`ZENTAO_URL`（站点地址）+ `ZENTAO_ACCOUNT` + （`ZENTAO_TOKEN` 或 `ZENTAO_PASSWORD`）。三项齐全时 CLI 不读本地 profile、不调登录、不落盘。
- 令牌来源：入口脚本用本机凭据向禅道 `POST {站点}/api.php/v1/tokens` 换当次令牌；凭据文件里直接写 `ZENTAO_TOKEN` 时用它，不再换。
- 认证头：`Token: <令牌>`；另有一个操作来源标记头（`--assistant` 的值，**不能含中文或换行**）。
- 首次调用会匿名取站点版本：`GET {站点}/?mode=getconfig`，响应体只要有字符串 `version`（如 `max8.2`）即可。
- 令牌只在入口脚本与 CLI 子进程之间经环境变量传递：**不进命令行参数、不打印、不落盘、不进 Agent 上下文**。

## 响应封装与退出码

- 成功：`stdout` 是 `{"ok":true,"data":<data>,"meta":{...}}`。`meta` 含 `returned` / `fetched` / `total` / `hasMore` / `truncated` / `processingScope`。
- list 的 `data` 是数组（CLI 已按资源键取出：`products` / `projects` / `bugs` / `feedbacks` / `issues`）；get 与 create 的 `data` 是对象。
- 失败：`stderr` 是 `{"ok":false,"error":{"code":"1004","message":"..."}}`，退出码非 0。
- 退出码：`0` 成功、`1` 执行失败、`2` 用法错误、`130` 取消。
- 服务端业务失败（HTTP 200 + `{"status":"fail","message":...}`）也会变成失败。

## 选项

- 全局：`--format=json|table|markdown|raw`、`--assistant <值>`、`--no-input`、`--yes`、`--quiet`、`--timeout <ms>`、`--deadline <ms>`、`--insecure`、`--profile`、`--config <文件>`。默认 `--format=table`，脚本取数一律显式给 `--format=json`。
- 其中两个由**入口脚本逐字转发**（所有子命令都能带，不是某个子命令专属）：
  - `--timeout <毫秒>`：单次 HTTP 请求的超时。**它不是**入口脚本等 CLI 子进程的那个超时（后者固定在脚本里，180 秒）。
  - `--insecure`：跳过 TLS 证书校验，只在实例用自签证书时用，并要说清风险。
  - 入口脚本的子命令选项白名单接受这两个旗标；写别的选项报用法错误（退出码 2）。
- list / get 才有：`--fields <逗号分隔>`（返回字段投影，响应里只剩这些字段）、`--html-to-markdown`。
- list 才有：`--all`（遍历全部页）、`--max-items <n>`、`--filter <expr>`、`--search <keywords>`、`--search-fields <fields>`、`--sort <expr>`（如 `id:asc`）、`--page <n>`、`--page-size <n>`。
  - 分页旗标就是 `--page` / `--page-size`（映射到服务端的 `pageID` / `recPerPage`）；`--page-id` / `--rec-per-page` 不是合法旗标。
  - **不要调小 `--page-size` 去绕开上下文截断**：截断是 Agent 侧的事，取数、过滤与字段投影都在入口脚本进程内做完，Agent 只拿结果。
- 有请求体的动作才有：`--data <json|@文件|@->`。`@文件` 读本地文件、`@-` 读 stdin，**正文因此不进 argv**。

### 过滤与检索的匹配语义

- `--search` 可重复：**一次出现 = 一个关键词组**，组内用逗号分隔是**且**，组与组之间是**或**。
- 匹配是**大小写不敏感的子串包含**；`--search-fields title` 把检索范围限制在指定字段（正文里的词不算命中）。
- `--filter` 语义相同（`字段=值` 表达式），组内且、组间或。
- `--search` / `--filter` / `--sort` / `--max-items` 都是**客户端**处理，只作用于已经取回的范围——要覆盖全部必须配 `--all`。
- 处理顺序：convert → filter → search → sort → limit → pick（字段投影最后做），所以 `--search-fields title` 与 `--fields id,title` 可以同时用。

## 命令面

路径相对 `{ZENTAO_URL}/api.php/v2`。例外：8.7 的 `feedback get` 会被 v2 详情接口 403 拒绝，入口脚本在 v2 明确返回 2006 时用同一账号 token 回退 `GET {ZENTAO_URL}/api.php/v1/feedbacks/{id}`，并归一化 v1 的账号对象与 HTML 正文；`ZENTAO_FEEDBACK_V1_FALLBACK=0` 可关闭回退。

| 命令 | HTTP | 路径 | 分页 | 请求体 |
| --- | --- | --- | --- | --- |
| `product list` | GET | `/products` | 有 | — |
| `project list` | GET | `/projects` | 有 | — |
| `bug list` | GET | `/{scope}/{scopeID}/bugs`（scope = `products` \| `projects` \| `executions`） | 有 | — |
| `bug get` | GET | `/bugs/{bugID}` | — | — |
| `bug create` | POST | `/bugs` | — | 有 |
| `bug update` | PUT | `/bugs/{bugID}` | — | 有 |
| `bug resolve` | PUT | `/bugs/{bugID}/resolve` | — | 有 |
| `bug close` | PUT | `/bugs/{bugID}/close` | — | 有 |
| `bug activate` | PUT | `/bugs/{bugID}/activate` | — | 有 |
| `feedback list` | GET | `/products/{productID}/feedbacks` | 有 | — |
| `feedback get` | GET | `/feedbacks/{feedbackID}` | — | — |
| `feedback create` | POST | `/feedbacks` | — | 有 |
| `feedback update` | PUT | `/feedbacks/{feedbackID}` | — | 有 |
| `feedback close` | PUT | `/feedbacks/{feedbackID}/close` | — | 有 |
| `feedback activate` | PUT | `/feedbacks/{feedbackID}/activate` | — | 有 |
| `issue list` | GET | `/issues` | 有 | — |
| `issue project-issues` | GET | `/projects/{projectID}/issues` | 有 | — |
| `issue execution-issues` | GET | `/executions/{executionID}/issues` | 有 | — |
| `issue get` | GET | `/issues/{issueID}` | — | — |
| `issue create` | POST | `/issues` | — | 有 |
| `file create` | POST | `/files`（multipart/form-data） | — | 有 |

`issue` 资源的命令面在实例 8.7 上可用；CLI 对 `issue` **没有** update / resolve / close / activate，技能第一版只做登记与查询，流转与改字段走禅道网页端（物理删除永不开放）。`bug confirm`、`feedback create-bug` / `create-story` 等 max8.5 动作技能不封装。`bug delete` / `feedback delete` 可用但**技能不开放**（物理删除走禅道网页端）。

## 字段

- `bug create`：`productID`（整数，必填）、`title`（必填）、`openedBuild`（字符串数组，必填）、`project`、`execution`、`severity`、`pri`、`type`、`steps`（HTML）、`story`、`assignedTo`（字符串）。
- `bug update`：`title`、`severity`、`pri`、`type`、`openedBuild`（数组）、`steps`、`project`、`execution`、`story`、`assignedTo`。
- `bug resolve`：`resolution`（必填，8 项枚举）、`resolvedDate`、`resolvedBuild`、`assignedTo`、`comment`。
- `bug close`：`comment`。`bug activate`：`openedBuild`、`assignedTo`、`comment`。
- `feedback create`：`product`（整数，必填）、`title`（必填）、`module`、`type`、`desc`（纯文本）、`feedbackBy`（字符串）、`source`。
- `feedback update`：`feedbackID`、`product`（必填）、`module`、`title`（必填）、`type`、`desc`、`feedbackBy`、`source`——**没有 `assignedTo`**。
- `feedback close`：`closedReason`（必填，`commented` / `repeat` / `refuse`）、`comment`、`confirmClose`。`feedback activate`：`assignedTo`、`comment`。
- `issue create`：`objectID`（整数，必填，所属项目）、`title`（必填）、`type`（必填，`design` 设计问题 / `code` 程序缺陷 / `performance` 性能问题 / `version` 版本控制 / `storyadd` 需求新增 / `storychanged` 需求修改 / `storyremoved` 需求删除 / `data` 数据问题）、`severity`（必填，1 严重 / 2 较严重 / 3 较小 / 4 建议）、`pri`（1-4）、`execution`、`assignedTo`、`owner`（提出人）、`deadline`（计划解决日期，命令行旗标是 `--data-deadline`）、`desc`（纯文本）、`from`（0 = 直接创建）。问题只挂项目，没有 `product` 字段。
- `issue get` / `issue project-issues`：`--fields` 投影；列表分页旗标与缺陷 / 反馈相同（`--all` / `--page` / `--page-size`）。
- `file create`：`file`（本地路径，必填）、`objectType`（`bug` \| `feedback`，必填）、`objectID`（整数，必填）。

### `update` 的 autoFill 与 `--ids` 批量

- **autoFill 只对 `update` 生效**：CLI 先 `GET` 一次当前对象，把 schema 里声明、用户没传、当前对象又有的字段补进请求体再 `PUT`——所以局部更新不会把未传字段覆盖为空。**状态流转（`resolve` / `close` / `activate`）不 autoFill**。
- **显式空串不会被当成缺省**：`assignedTo: ""` 会原样送出去（取消指派）。
- **`--ids` 批量**：`update` / `resolve` / `close` / `activate` 都认 `--ids <id,...>`（逗号分隔、去重）与 `--batch-fail-fast`；CLI 内部逐条串行调用，`--format=json` 时输出 `{ok, data:[{objectID, ok, data|skipped|error}], meta:{success, failed, skipped}}`，有失败则退出码 1。批量无服务端事务，中途失败不回滚已成功条目。

### 传图（`file create`）

`zentao file create --file <本地路径> --object-type <类型> --object-id <单据ID>` → `POST /api.php/v2/files`，`multipart/form-data`。

- 单文件上限 **50 MiB**，超了 SDK 直接拦；先压缩再传。
- `--file` 是本地路径，由跑 CLI 的那台机器解析（相对路径相对 CLI 的工作目录）；MIME 按扩展名推断，不认识的一律 `application/octet-stream`。
- **`objectType` 没有 enum 校验**：帮助文本只列 `bug` / `story` / `task` / `testcase`，但 `feedback` 会原样透传给服务端并绑定成功（证据：issue #13 判据③）。所以缺陷单与反馈单都能挂图，不要按帮助文本把 `feedback` 禁掉。
- 返回 `{"ok":true,"data":{"file":{"id":…}}}`：文件标识是 `data.file.id`（实测）。
- **没有 `file list` / `file get`**：附件身份只能靠上传返回的文件标识 + 单据正文里的引用核对，**无法逐字节回读附件**。所以传图后的核对是「回读目标单据：正文里有那张图的引用（`fileID` 与上传返回一致）、附件挂载对象（`objectType`/`objectID`）就是目标单据」。
- 上传没有幂等键：重复上传会多出附件。超时、断连、读不懂响应时先查单据上有没有多出附件，**不重传**。

## 错误码

| 码 | 含义 |
| --- | --- |
| `1001` | 完整环境凭据不足（`details.reason = "incomplete_environment"` 表示只给了一部分） |
| `1002` | 禅道地址无法访问 |
| `1003` / `1004` | 用户名密码不对 / 令牌失效 |
| `1005` / `1011` | 配置读取 / 写入失败 |
| `1006` | 没有可用默认凭据 |
| `2002` | 找不到对象（也对应 HTTP 404） |
| `2003` / `2004` | 缺必填参数 / 参数值无效 |
| `2006` | 当前账号没有权限（也对应 HTTP 403） |
| `2007` / `2009` | `--data` 的 JSON 无效 / 选项值无效（未知选项、冲突值、非法枚举、`@文件` 读不到） |
| `2008` | 服务端返回错误（也用于分页异常） |
| `2010` | 当前服务器版本不支持该动作 |
| `2011` / `2012` | 认不出服务器版本 / 认不出站点配置 |
| `5001` / `5002` / `5003` | 超时 / 证书校验失败 / 请求被取消 |

文本输出写成 `E####`，JSON 里是裸数字。入口脚本把 CLI 的失败转成一句人话放在 stderr（`错误：禅道 CLI 报错（<码>）：<原因>`），**不回显站点地址与凭据**；调用方按码分类，不靠中文信息抠字。四类分流与用户能懂的下一步见 [error-handling.md](error-handling.md)。

## 版本锁

官方禅道 CLI 的版本钉在技能包 `config.local.json` 里：

```json
"zentaoCli": { "package": "zentao-cli", "version": "0.4.4" }
```

- 装 CLI 只认这个版本（本机实测的也是 `0.4.4`），打包脚本把它原样带进分发出去的包里。
- **升级由发版流程显式发起**：改 `config.local.json` 的 `version` → 跑一次接入自检验证 → 重新发版。业务用户不要自己跑 `npm i -g zentao-cli@latest`，技能也不在运行时升级 CLI。
- 本机 `zentao --version` 与版本锁对不上时，按 [setup.md](setup.md)「Agent 执行路径」重装固定版本，再跑自检。

## 已知限制（实测坑）

- **反馈列表的第一次请求会忽略 productID**：同一令牌的第一次 `GET /api.php/v2/products/{id}/feedbacks` 会返回**全局**记录（请求产品 29 会拿到产品 1 的 51 条）；第二次起才按产品过滤，分页也恢复正常。这不是接口路径用错：官方 CLI 的生成定义就是 `/products/{productID}/feedbacks`。入口脚本在 `runListScan` 里先发一次 `page 1 / page-size 1` 的预热请求，再执行真正的 `--all`；预热后实测产品 29 = 1 条、产品 1 = 32 条（默认 `wait`），`complete:true`、`foreignRecords:0`。预热失败时仍走下面的兜底。这是**禅道服务端的缺陷**（[issue #25](https://github.com/xuxzh/ruihui-skills/issues/25)），**服务端仍未修**——客户端只是绕过，不是修好了它；多节点部署或没有粘性会话时需要重新验证。
- **兜底（预热失败或服务端又变）**：CLI 的 `--all` 发现「请求的页码 ≠ 服务端回的页码」会报 `E2008`「服务端分页未向前推进」，整条读取失败；入口脚本退回只读第 1 页，并把这次扫描标成**覆盖不完整**（输出里写「服务端分页未向前推进，覆盖不完整」）。
- **同一个接口会返回别的产品的记录**：请求产品 29 的反馈列表，回来的记录 `product` 字段是 `"1"`，且 ID 序列与产品 1 的完全一致（`51,50,49,20,48`）。所以只看「拿到了 N 条」不能当成「这个产品有 N 条」。
- **技能的对策（`scripts/zentao.mjs`）**：分页不前进时**不整体失败**，退回「只读第 1 页」并把这次扫描标成**覆盖不完整**（输出里写「服务端分页未向前推进，覆盖不完整」）；同时用每条记录的 `product` 字段做**归属校验**，不属于请求产品的记录一律丢弃并在输出里点名（「禅道返回的 N 条记录 product 字段是 X，不属于产品 Y，已丢弃」）。写入前的查重基线不完整或有记录被丢弃时，写入结果不确定只能报**未确认**，不凭基线判成功、不重发。
- **`user list` 的服务端 `filters` 在实例上被忽略**：`zentao user list --filters …` 返回全部用户（实测 51 条）。所以查产品 QD 时先把用户表取全（`--fields account,realname,deleted,locked,last`），**在入口脚本里按账号筛**。注意最后登录字段叫 `last`；账号失效标记只看 `deleted`（`"1"` = 已删除）与 `locked`（非空 = 已锁定）。
- **产品 QD 的字段名是大写 `QD`**：`product list --fields id,name,QD` 能取到（形如 `{"id":"1","name":"<产品名>","QD":"<账号>"}`）；小写 `qd` 不是合法字段名，会被静默忽略（字段投影里就没这一列了）。QD 属于运行时事实：只查不存，不写进随包配置或仓库文件。
- **选品不再有 `prep` 合并调用**：旧查询器的 `prep`（产品 + 项目 + 查重候选一次拿全）随旧通道下线，迁移后改成显式的三个子命令：`products` → `projects --product <id>` → `dup --kind … --product … --title …`。这不是漏做，是拆开让每一步都能单独重试与核对。
- **正文里的图片引用会被服务端补属性**：落库后 `<img>` 会多出 `onload="setImageSize(this,0)"` 等属性；入口脚本比较正文时只按 `fileID` 归一化图片标签，不比较属性差异，避免把“同一张图”误判成正文不一致。缺陷单的 `steps` 还会被剥标签，剥之前先把图片引用归一成 `<img fileID="N">` 留下——「图片引用落在正文里」在回读投影与逐字比较里都看得见，认不出 `fileID` 的 `<img>` 按普通标签剥掉。
- **`get` 不返回 `actions`**：CLI 0.4.4 的 `bug get` / `feedback get` 即使 `--fields` 里带 `actions`，返回的 JSON 里也没有这个字段（服务端 API 有流水，CLI 没映射；实测缺陷 1936 与反馈 51）。因此入口脚本的回读策略是：**有 `actions` 字段**时按 `opened` / `edited` 核对；**字段不存在**时，建单用 `openedBy` + `openedDate`，更新用“正文与完整预期正文逐字一致”（写前复核已确认原文不同）。不要要求用户为了流水去换通道或升级 CLI。反馈详情走 v1 回退时，v1 详情**有** `actions`（实测反馈 75）；所以 8.7 上 `feedback --id` 可能看到流水，而 `bug --id` 仍没有——按实际返回的字段核对即可。
- **`feedback update` 的 autoFill 也走 v2 详情**：CLI 在 PUT 前会先 GET 当前对象补齐未提交字段；8.7 上这一步被 2006 拒绝，更新请求根本发不出去。入口脚本在写前发现详情来自 v1 回退时直接报 `writeBlocked:true`，不发出更新、不重放；需要改反馈请走禅道网页端，或等 v2 详情修复。
- **项目问题的创建者字段是 `createdBy`**：`issue get` 没有 `openedBy`，创建者看 `createdBy`、创建时间看 `createdDate`；提出人是业务字段 `owner`（入口脚本建单时显式填当前账号）。状态以实例工作流为准（常见 `open` / `assigned` / `resolved` / `closed` / `canceled`），列表 browseType 与缺陷相近（`all` / `open` / `assignto` / `assignby` / `closed` / `resolved` / `canceled`）。

## 与随包脚本的分工

| 谁 | 干什么 |
| --- | --- |
| `scripts/zentao.mjs` | 读凭据、换令牌、注入 CLI、调子命令、投影输出；写子命令（建单 / 更新 / 流转 / 传图）一律先做格式与状态预检，写后回读核对；批量先预检再串行执行并三栏汇报；失败时给可读错误与非 0 退出码 |
| `scripts/connect.mjs` | 只在首次接入时用：起本机一次性页面收账号密码/个人令牌，验证通过后写本机凭据（0700/0600），写完自关；不读写任何禅道数据（只发一次换令牌与一次产品列表） |
| 禅道 CLI | 拼 HTTP 请求、翻页、客户端过滤与字段投影 |
| Agent | 只看投影后的表格与结论；凭据、令牌、原始 JSON 都不经手 |

- 列表类 → 制表符紧凑表格（带一行 `#` 开头的说明）；详情与写入类 → 一行 JSON。
- 失败 → stderr 打「错误：…」、stdout 打 `{"ok":false,…}`、退出码非 0。
