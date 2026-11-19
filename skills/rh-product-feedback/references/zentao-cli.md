# 禅道 CLI（接入通道）

技能的默认接入通道是**官方禅道 CLI**（npm 包 `zentao-cli`，可执行文件 `zentao`）。随包入口脚本 `scripts/zentao.mjs` 把三件事包在进程内做完：读本机凭据换当次令牌 → 以环境变量注入 CLI 子进程 → 调 CLI 取数并投影成紧凑表格。Agent 只见投影后的结果，原始 JSON 不进上下文。

本文件是命令、字段、枚举与错误码的参考；话术与输出样例见 [workflow.md](workflow.md)。**读详情、写单据、查重的段落随迁移逐段补齐。**

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
- list / get 才有：`--fields <逗号分隔>`（返回字段投影，响应里只剩这些字段）、`--html-to-markdown`。
- list 才有：`--all`（遍历全部页）、`--max-items <n>`、`--filter <expr>`、`--search <keywords>`、`--search-fields <fields>`、`--sort <expr>`（如 `id:asc`）、`--page <n>`、`--page-size <n>`。
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
- **没有 `file list` / `file get`**：附件身份只能靠上传返回的文件标识 + 单据正文里的引用核对。
- 上传没有幂等键：重复上传会多出附件。超时、断连、读不懂响应时先查单据上有没有多出附件，**不重传**。

## 错误码

| 码 | 含义 |
| --- | --- |
| `1001` | 完整环境凭据不足 |
| `1006` | 没有可用默认凭据 |
| `1003` / `1004` | 登录失败 / 令牌失效 |
| `1005` / `1011` | 配置读取 / 写入失败 |
| `2003` / `2004` / `2007` / `2009` | 必填、类型、JSON 或冲突输入有问题 |
| `2002` / `2006` / `2008` | URL、权限、服务器响应问题（**不据此认定记录已删除**） |
| `2010` | 当前服务器版本不支持该动作 |
| `1002` / `5001` / `5002` | 网络、超时、证书问题 |

入口脚本把 CLI 的失败转成一句人话放在 stderr（`错误：禅道 CLI 报错（<码>）：<原因>`），**不回显站点地址与凭据**。

## 与随包脚本的分工

| 谁 | 干什么 |
| --- | --- |
| `scripts/zentao.mjs` | 读凭据、换令牌、注入 CLI、调子命令、投影输出；失败时给可读错误与非 0 退出码 |
| 禅道 CLI | 拼 HTTP 请求、翻页、客户端过滤与字段投影 |
| Agent | 只看投影后的表格与结论；凭据、令牌、原始 JSON 都不经手 |

- 列表类 → 制表符紧凑表格（带一行 `#` 开头的说明）；详情与写入类 → 一行 JSON。
- 失败 → stderr 打「错误：…」、stdout 打 `{"ok":false,…}`、退出码非 0。
