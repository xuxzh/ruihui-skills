# 生命周期流转与字段编辑

缺陷单（`bug`）与反馈单（`feedback`）的可逆流转、字段编辑与批量操作都走**同一个入口脚本**的子命令，底层调官方禅道 CLI 的 `resolve` / `close` / `activate` / `update` 动作。物理删除不开放。本文给命令面、参数契约、分级确认规则与输出样例；示例数据均为虚构。

## 命令面

| 子命令 | 对象 | 必填 | 可选 |
| --- | --- | --- | --- |
| `bug-resolve` | 缺陷 | `--resolution <枚举>` | `--resolved-date YYYY-MM-DD`、`--resolved-build <版本>`、`--assigned-to <账号>`、`--comment <备注>` |
| `bug-close` | 缺陷 | — | `--comment <备注>` |
| `bug-activate` | 缺陷 | — | `--opened-build <版本,...>`、`--assigned-to <账号>`、`--comment <备注>` |
| `feedback-close` | 反馈 | `--closed-reason <枚举>` | `--comment <备注>`、`--confirm-close <1\|yes\|true>` |
| `feedback-activate` | 反馈 | — | `--assigned-to <账号>`、`--comment <备注>` |

所有流转子命令都认这几个公共选项：

- `--id <单据ID>` 或 `--ids <ID,...>`：二选一。`--ids` 去重后单批最多 **20 条**。
- `--payload-file <路径>`：多行备注等长文本走文件，不进命令行参数；与命令行选项同字段**值不同就报冲突**。
- `--preview`：只读预检，逐条给出「可执行 / 跳过 / 失败」清单，**不写入**、不删载荷文件。
- `--fail-fast`：批量时首个失败后剩余目标跳过并标注。

`bug-update` / `feedback-update` 扩成两种模式（`--mode`，缺省按载荷形态判定）：

| 模式 | 用途 | 载荷 | 批量 |
| --- | --- | --- | --- |
| `append`（缺省，载荷含 `steps` / `desc`） | 补充说明、带图追加 | 原文 + 分隔行 + 追加段落 + `expectedBody`，走 `--payload-file` | 不支持 |
| `edit` | 改派、改优先级 / 严重程度 / 类型 / 项目 / 影响版本；改标题或改正文 | 命令行选项或 `--payload-file`（字段清单见下）；改正文/标题必须带 `expectedBody` / `expectedTitle` | 仅非正文统一字段 |

编辑模式认的字段：

| 对象 | 字段 | 格式 |
| --- | --- | --- |
| 缺陷 | `--assigned-to <账号>` | 字符串；`""` = 取消指派 |
| 缺陷 | `--pri` / `--severity` | 1 到 4 的整数 |
| 缺陷 | `--type` | `codeerror` / `config` / `install` / `security` / `performance` / `standard` / `automation` / `designdefect` / `others` |
| 缺陷 | `--project` / `--execution` / `--story` | 非负整数（`0` = 不挂） |
| 缺陷 | `--opened-build` | 逗号分隔的版本列表，`trunk` 为主干 |
| 缺陷 / 反馈 | `--type`（反馈） | `story` / `task` / `bug` / `todo` / `advice` / `issue` / `risk` / `opportunity` |
| 反馈 | `--product` / `--module` | 正整数 / 非负整数 |

反馈单的 `update` 动作**没有** `assignedTo` 字段（官方 CLI 0.4.4 的 schema 如此）：要改派反馈单，用 `feedback-activate --assigned-to` 或走禅道网页端。载荷里给 `feedback-update` 带 `assignedTo` 会被拒绝并指到 `feedback-activate`。

## 格式与状态护栏（脚本进程内强制，先于 CLI 调用）

| 护栏 | 规则 | 拦下时 |
| --- | --- | --- |
| 必填枚举 | `bug-resolve` 的 `resolution` ∈ `fixed \| notrepro \| bydesign \| duplicate \| external \| postponed \| willnotfix \| tostory`；`feedback-close` 的 `closedReason` ∈ `commented \| repeat \| refuse` | 退出码 1，一个写请求都不发 |
| 日期 | `resolvedDate` 必须是 `YYYY-MM-DD` 且是真实日期 | 同上 |
| 数字 | `pri` / `severity` 1–4；`project` / `execution` / `story` / `product` / `module` 非负整数 | 同上 |
| `confirmClose` | 只接受 `true`、`"1"`、`"yes"`、`"true"` | 同上 |
| 幂等冗余 | 已 `resolved` 再 resolve、已 `closed` 再 close、已 `active` 再 activate、未关闭的反馈再 activate | 预检拦下，不发写请求（批量时计入 skipped） |
| 状态机冲突 | `closed` 的缺陷不能直接 resolve；非 `resolved` / `closed` 的缺陷不能 activate | 同上 |
| 工作流提示 | `active` 的缺陷直接 close 带 warning（多数禅道工作流要求先 resolve）；服务端拒绝时附「先执行 bug-resolve 再执行 bug-close」 | 照常尝试，失败时给下一步 |
| `duplicate` 提示 | `resolution=duplicate` 且 `comment` 里没有数字时给 warning（CLI 0.4.4 未暴露 `duplicateBug` 字段） | 照常写入，输出里带 `warnings` |
| CAS 复核 | 编辑模式改标题 / 正文时，写前再读一次与 `expectedTitle` / `expectedBody` 比对 | 停手，`conflict:true`，不发写请求 |

## 两档分级确认

**免二次确认直通执行**（脚本仍做上面的全部护栏）：单条可逆流转或非正文元数据微调，且用户在指令里**明确给出了数字 ID、动作与全部必填业务参数**（无 AI 推断、无 `confirmClose`）。

**必须先展示草稿 / 清单再写入**：

- 新建单据（保持查重 + 草稿确认）；
- 目标 ID 或必填枚举由 AI 搜索 / 推断补全，或触发 `confirmClose`；
- 修改或改写正文 / 标题（含补充说明追加与 CAS 改写）；
- 批量操作（目标数量 ≥ 2）：先跑 `--preview` 把清单给用户看，确认后再执行。

## 输出样例

单条流转成功（一行 JSON）：

```json
{"ok":true,"kind":"bug","action":"resolve","id":1945,"title":"切换语言后页面文案仍是中文","status":"resolved","assignedTo":"dev-a","resolution":"fixed","resolvedDate":"2026-03-12","resolvedBuild":"trunk","url":"<禅道 Web 地址>/bug-view-1945.html","verified":"readback","newActions":["resolved"]}
```

预检拦下（退出码 1，stdout 一行 `ok:false`，stderr 一句人话）：

```
错误：缺陷 #1946 当前已是 closed 状态，无需重复关闭
```

预览（退出码 0，不写入）：

```json
{"ok":true,"preview":true,"kind":"bug","action":"resolve","total":3,"executable":[{"id":1945,"title":"…","status":"active"}],"skipped":[{"id":1946,"title":"…","status":"resolved","reason":"当前已是 resolved 状态，无需重复解决"}],"failed":[{"id":9999,"reason":"记录不存在"}]}
```

批量执行（三栏汇报；有失败时退出码 1）：

```json
{"ok":false,"batch":true,"kind":"bug","action":"close","total":3,"succeeded":[{"id":1945,"title":"…","status":"closed","verified":"readback","newActions":["closed"]}],"skipped":[{"id":1946,"title":"…","status":"closed","reason":"当前已是 closed 状态，无需重复关闭"}],"failed":[{"id":1947,"title":"…","status":"active","stage":"write","uncertain":false,"reason":"禅道 CLI 报错（2008）：该缺陷未解决，不能关闭。（若实例工作流要求先解决再关闭，请先执行 bug-resolve 再执行 bug-close）"}],"counts":{"succeeded":1,"skipped":1,"failed":1}}
```

编辑模式成功：

```json
{"ok":true,"kind":"bug","mode":"edit","id":1945,"title":"…","status":"active","assignedTo":"dev-b","updated":true,"verified":"readback","newActions":["edited"],"url":"<禅道 Web 地址>/bug-view-1945.html"}
```

CAS 冲突（退出码 1，`mergedDraft` 只在追加模式给）：

```json
{"ok":false,"kind":"bug","id":1945,"conflict":true,"changed":["正文"],"currentTitle":"…","currentBody":"…","currentBodyText":"…","message":"这条缺陷单在你确认期间被改过（正文变了），我还没写入。请向终端用户核对当前内容后再决定是否继续。"}
```

`verified` 为 `query` 说明写入请求没拿到回执（超时 / 断连），结论来自只读核实；为 `readback` 说明回执与回读都过了。`newActions` 是本次新增的流水动作名（历史上有过不算）。

## 边界

- **物理删除不开放**：没有 `bug-delete` / `feedback-delete` 子命令；要删单走禅道网页端。
- **`max8.5` 动作不纳入**：`bug confirm`、`feedback create-bug` 等属于另立的发版决定，本技能不封装；实例 8.7 已支持这些动作，但技能第一版不开放。
- **批量无服务端事务**：中途失败时已成功条目保持落库，客户端靠批前预检、20 条上限与三栏回执控制影响面，失败项不自动重试。
- **回读以状态为准**：CLI 0.4.4 的 `get` 不返回 `actions` 时，以状态与请求字段对上为准，不凭空要求流水。
