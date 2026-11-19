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
- list 的 `data` 是数组（CLI 已按资源键取出：`products` / `projects` / `bugs` / `feedbacks`）；get 与 create 的 `data` 是对象。
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

路径相对 `{ZENTAO_URL}/api.php/v2`。

| 命令 | HTTP | 路径 | 分页 | 请求体 |
| --- | --- | --- | --- | --- |
| `product list` | GET | `/products` | 有 | — |
| `project list` | GET | `/projects` | 有 | — |
| `bug list` | GET | `/{scope}/{scopeID}/bugs`（scope = `products` \| `projects` \| `executions`） | 有 | — |
| `bug get` | GET | `/bugs/{bugID}` | — | — |
| `bug create` | POST | `/bugs` | — | 有 |
| `bug update` | PUT | `/bugs/{bugID}` | — | 有 |
| `feedback list` | GET | `/products/{productID}/feedbacks` | 有 | — |
| `feedback get` | GET | `/feedbacks/{feedbackID}` | — | — |
| `feedback create` | POST | `/feedbacks` | — | 有 |
| `feedback update` | PUT | `/feedbacks/{feedbackID}` | — | 有 |
| `file create` | POST | `/files`（multipart/form-data） | — | 有 |

## 字段

- `bug create`：`productID`（整数，必填）、`title`（必填）、`openedBuild`（字符串数组，必填）、`project`、`execution`、`severity`、`pri`、`type`、`steps`（HTML）、`story`、`assignedTo`（字符串）。
- `bug update`：`title`、`severity`、`pri`、`type`、`openedBuild`（数组）、`steps`、`project`、`execution`、`story`、`assignedTo`。
- `feedback create`：`product`（整数，必填）、`title`（必填）、`module`、`type`、`desc`（纯文本）、`feedbackBy`（字符串）、`source`。
- `feedback update`：`feedbackID`、`product`（必填）、`module`、`title`（必填）、`type`、`desc`、`feedbackBy`、`source`。
- `file create`：`file`（本地路径，必填）、`objectType`（`bug` \| `feedback`，必填）、`objectID`（整数，必填）。

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

- **反馈列表接口在部分产品上分页不前进**：`GET /api.php/v2/products/{id}/feedbacks` 在某台 max 8.2 实例的产品 29 上，同一个令牌的第 1 次请求正常（20 条、`pager.recTotal=51`、`pageTotal=3`），第 2 次及以后返回空集且 `pager.pageID` 钳回 1、`recTotal=0`；`pageID=2` 同样如此。CLI 的 `--all` 保护发现「请求的页码 ≠ 服务端回的页码」就报 `E2008`「服务端分页未向前推进」，整条读取失败。同一实例的产品 1 上完全正常，`bug list --all` 在各产品上也正常。换一个新令牌后的第 1 次请求又正常（按令牌/会话计的现象，具体原因未查证）。
- **同一个接口会返回别的产品的记录**：请求产品 29 的反馈列表，回来的记录 `product` 字段是 `"1"`，且 ID 序列与产品 1 的完全一致（`51,50,49,20,48`）。所以只看「拿到了 N 条」不能当成「这个产品有 N 条」。
- **技能的对策（`scripts/zentao.mjs`）**：分页不前进时**不整体失败**，退回「只读第 1 页」并把这次扫描标成**覆盖不完整**（输出里写「服务端分页未向前推进，覆盖不完整」）；同时用每条记录的 `product` 字段做**归属校验**，不属于请求产品的记录一律丢弃并在输出里点名（「禅道返回的 N 条记录 product 字段是 X，不属于产品 Y，已丢弃」）。写入前的查重基线不完整或有记录被丢弃时，写入结果不确定只能报**未确认**，不凭基线判成功、不重发。
- **`user list` 的服务端 `filters` 在实例上被忽略**：`zentao user list --filters …` 返回全部用户（实测 51 条）。所以查产品 QD 时先把用户表取全（`--fields account,realname,deleted,locked,last`），**在入口脚本里按账号筛**。注意最后登录字段叫 `last`；账号失效标记只看 `deleted`（`"1"` = 已删除）与 `locked`（非空 = 已锁定）。
- **产品 QD 的字段名是大写 `QD`**：`product list --fields id,name,QD` 能取到（形如 `{"id":"1","name":"<产品名>","QD":"<账号>"}`）；小写 `qd` 不是合法字段名，会被静默忽略（字段投影里就没这一列了）。QD 属于运行时事实：只查不存，不写进随包配置或仓库文件。
- **选品不再有 `prep` 合并调用**：旧查询器的 `prep`（产品 + 项目 + 查重候选一次拿全）随旧通道下线，迁移后改成显式的三个子命令：`products` → `projects --product <id>` → `dup --kind … --product … --title …`。这不是漏做，是拆开让每一步都能单独重试与核对。

## 与随包脚本的分工

| 谁 | 干什么 |
| --- | --- |
| `scripts/zentao.mjs` | 读凭据、换令牌、注入 CLI、调子命令、投影输出；失败时给可读错误与非 0 退出码 |
| 禅道 CLI | 拼 HTTP 请求、翻页、客户端过滤与字段投影 |
| Agent | 只看投影后的表格与结论；凭据、令牌、原始 JSON 都不经手 |

- 列表类 → 制表符紧凑表格（带一行 `#` 开头的说明）；详情与写入类 → 一行 JSON。
- 失败 → stderr 打「错误：…」、stdout 打 `{"ok":false,…}`、退出码非 0。
