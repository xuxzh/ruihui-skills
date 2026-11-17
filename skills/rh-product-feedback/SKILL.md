---
name: rh-product-feedback
description: 把自然语言产品反馈（Bug、需求、优化建议）提交到禅道 ZenTao 生成反馈单并回读校验；也支持查询反馈单、解释处理进度（当前状态、负责人、处理历史、是否排期）、补充说明。触发场景：用户要「提 Bug / 报问题 / 提需求 / 提建议 / 提交反馈 / 查反馈 / 看反馈到哪了 / 为什么还没排期 / 补充反馈信息」，或提到 report a bug、file a feature request、check feedback status、add a comment to my feedback。
compatibility: 需要连接禅道 MCP（工具名前缀 zentao，至少含 post_users_login、post_feedbacks、put_feedbacks_feedbackID、get_feedbacks_feedbackID、get_products_productID_feedbacks）并能访问该服务。
metadata:
  rh-version: "0.1.0"
  rh-mcp-server: zentao
---

# rh-product-feedback

把用户的自然语言反馈变成禅道里的**反馈单**（`feedback` 对象），并支持查询、进度解释与补充说明。

禅道 MCP 的工具名、参数包装、字段与枚举都以实测为准 → 读 [references/zentao-mcp.md](references/zentao-mcp.md)。
本文件只保留流程与硬约束；模板、话术与错误处理按需下钻。

## 术语

- **反馈单**：禅道 `feedback` 对象（`post_feedbacks` 创建、`get_feedbacks_feedbackID` 读取）。
- **草稿**：写库前展示给用户确认的结构化内容。
- **回读**：写入后用返回的 ID 重新读取，核对内容与操作流水。
- **共享服务账号**：MCP 用服务端配置的禅道账号操作，所有记录都留痕在该账号上。

## 0. 会话第一步：登录

调用 `post_users_login`，参数包在 `payload` 内：`{"payload": {"account": "<账号>", "password": "<密码>"}}`。

- 凭据从运行环境取（环境变量或仓库 `.env`）。不要在回复、日志、代码或文档里回显账号、密码、token。
- 登录一次后，本会话后续调用自动带 token。
- 收到 HTTP 401 → 重新登录一次，重试该调用一次；仍失败则停止并报告认证失败，保持权限边界不被绕过。
- 服务端若以占位符替换账号密码，传入占位值即可，不要因此向用户索要凭据。

完成标准：拿到一次成功登录；或给出明确的认证失败结论与建议动作。

## 1. 路由意图

| 用户表达 | 流程 | 反馈类型 |
| --- | --- | --- |
| 「有个问题 / 页面报错 / 复现步骤是…」 | [提交反馈](#2-提交反馈) | Bug |
| 「需要一个功能 / 希望支持…」 | 提交反馈 | 需求 |
| 「体验不好 / 建议优化…」 | 提交反馈 | 建议 |
| 「反馈 123 什么状态 / 谁在处理 / 处理到哪了 / 为什么还没排期」 | [查询与解释进度](#3-查询与解释进度) | — |
| 「再补充一点 / 又复现了一次 / 补上业务场景」 | [补充反馈](#4-补充反馈) | — |

意图不明时问一句再动手。用户明确要「提交」时，走提交流程；只描述问题但没说要提交时，先确认意图。

## 2. 提交反馈

### 2.1 收集要素

按 [references/feedback-templates.md](references/feedback-templates.md) 的模板收集。

- 必备：标题（一句话说清问题）、所属产品、类型、现象或期望、业务场景。
- Bug 追加：复现步骤、实际结果、预期结果。
- 需求追加：期望能力、使用场景。
- 建议追加：现状痛点、期望改进。
- 只追问真正影响分类、复现或验收的信息，一次问全；用户没说的版本号、模块、负责人一律不补写，缺什么就在草稿里写「用户未提供」。

完成标准：模板里每一项都有内容或明确标注缺失。

### 2.2 生成草稿

按模板渲染描述正文。草稿要能独立读懂——用户只看草稿就知道禅道里会存下什么。

### 2.3 查重

禅道 MCP 没有服务端关键词检索，查重靠客户端匹配：

1. `get_products_productID_feedbacks`，`recPerPage=100`，最多取 3 页（上限 300 条）。
2. 在客户端按标题关键词匹配（大小写与空格归一化，取标题中最有区分度的词）。
3. 把候选连同 ID、标题、状态列给用户，让用户选：新建 / 复用候选 / 都不是。

只覆盖拉取到的范围。向用户说明「在已扫描的 N 条中未发现重复」，而不是「没有重复」。

### 2.4 用户确认

展示：类型、所属产品、标题、描述全文、查重结果。

用户明确确认后才写入。只有「嗯」「行吧」而没看到草稿时，先把草稿给出来再问一次。

### 2.5 创建

`post_feedbacks`，全部字段放进 `payload`：

```json
{"payload": {"product": 42, "title": "<标题>", "desc": "<描述全文>", "type": "bug"}}
```

- `type` 映射：Bug → `bug`，需求 → `story`，建议 → `advice`。
- `product` 是产品 ID（整数，示例里的 42 是占位），先从 `get_products` 确认；`product` 与 `title` 是禅道实际必填项。
- `desc` / `source` / `module` / `feedbackBy` 保持不填：`feedbackBy` 填终端用户姓名会与实际留痕账号矛盾。
- 只发一次调用。创建接口没有幂等键，同一份 payload 发两次会产生两条记录。

### 2.6 回读校验

用返回的 `id` 调 `get_feedbacks_feedbackID`，核对 `title`、`desc`、`status`，并确认 `actions` 里有 `opened`。

- 一致 → 进入 2.7。
- 不一致或读不到 → 按 [references/error-handling.md](references/error-handling.md) 处理：先查后报，不重复创建。

### 2.7 交付

给出反馈 ID、标题、当前状态、负责人（没有则说明尚未指派）、以及下一步建议（等待评审 / 需要补充什么信息 / 与哪条既有反馈重复）。

## 3. 查询与解释进度

### 3.1 定位反馈单

- 用户给了数字 ID → `get_feedbacks_feedbackID`。
- 用户描述产品或标题 → `get_products_productID_feedbacks` 分页拉取后客户端匹配，把候选列给用户确认。

### 3.2 读事实

从详情里取：`status`、`assignedTo`、`processedBy`、`processedDate`、`reviewedBy`、`reviewedDate`、`result`、`solution`、`faq`、`repeatFeedback`，以及 `actions[]`（`action` / `actor` / `comment` / `date`）与其中的 `history[]`（字段级差异）。

`actions[]` 与 `actions[].history[]` 运行时才返回，工具的 Schema 里没有声明——按运行时数据读。

### 3.3 三段式解释

输出分三段，不混写：

1. **事实**：直接来自字段与 `actions[]` 的陈述（谁、何时、把什么改成了什么）。
2. **推断**：基于事实的判断，逐条标注「推断」。
3. **无法确定**：接口里没有的信息（如未排期原因）。

例：`plan` 与 `version` 均为空，只能说明「禅道里没有排期记录」，不能等同于「产品经理拒绝了需求」——后者是推断，且必须写明它只是推断。

### 3.4 输出格式

当前状态 / 负责人 / 处理时间线（`actions` 倒序）/ 结论 / 需要补充的信息。

## 4. 补充反馈

补充说明走「更新描述」这条可靠路径：读取原文 → 生成追加草稿 → 用户确认 → 更新 → 回读。

1. **读原文**：`get_feedbacks_feedbackID` 取当前 `desc`。
2. **生成追加草稿**：原文完整保留，下方追加分隔行与追加段落（复现步骤 / 业务场景 / 预期结果 / 实际结果 / 其他说明），标注追加时间与「用户口述，AI 整理」。
3. **用户确认**：展示完整的新描述（原文 + 追加段）。
4. **更新**：`put_feedbacks_feedbackID`，`payload` 里带 `product`（数字 ID）、`title`（沿用原值，禅道要求）与新的 `desc`。`product` 传字符串会被服务端静默忽略。
5. **回读**：核对 `desc` 是新内容，且 `actions` 新增 `edited`。

禅道没有「只评论不改状态」的接口。关闭、激活、解决等流转会改变单据状态，因此不适合承载补充说明。

## 硬约束

1. **写入前确认**：所有业务写入都要用户明确确认后执行。
2. **写入后回读**：按 ID 重新读取并核对内容，「保存成功」的文本不作为落库证据。
3. **不确定先查**：超时、连接中断、返回与预期不符时，先查询核实再决定下一步；同一份内容不重复创建。禅道创建无幂等，盲目重试会造重复单。
4. **身份边界**：MCP 用共享服务账号操作，`openedbyme` 指的是这个服务账号，不是对话里的终端用户。把结果说成某个员工的个人工单是不实陈述。说明时用「禅道里记录的提交人是共享服务账号」。
5. **附件**：MCP 的附件上传实测不可用。用户要传截图时，说明当前能力不支持，请其贴文字说明或走禅道 Web 端上传后再补充描述。
6. **不做人的决定**：关闭、删除、解决、重新打开单据，以及指派负责人，都由人来做；Agent 只提交内容与读取状态。
7. **不写凭据**：账号、密码、token、内网地址不进回复、不进代码、不进文档。

## 参考文件

- [references/feedback-templates.md](references/feedback-templates.md)：起草与追问用的模板与必填项（写草稿时读）
- [references/zentao-mcp.md](references/zentao-mcp.md)：工具映射、`payload` 包装、字段与枚举（调 MCP 前读）
- [references/workflow.md](references/workflow.md)：四个流程的完整话术与示例（拿不准输出格式时读）
- [references/error-handling.md](references/error-handling.md)：错误分类、恢复动作与话术（出现报错、超时或结果不一致时读）
