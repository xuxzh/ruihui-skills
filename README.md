# ruihui-skills

瑞辉（Ruihui）开源的 [Agent Skills](https://agentskills.io/) 集合。每个技能是一个独立目录，包含一个 `SKILL.md` 与按需加载的 `references/`。

| 技能 | 版本 | 说明 |
| --- | --- | --- |
| [`rh-product-feedback`](skills/rh-product-feedback) | 0.3.0 | 产品反馈助手：用自然语言把 Bug / 需求 / 优化建议提交成禅道反馈单，并支持查询反馈单、解释处理进度、补充说明；禅道 MCP 没配好时，能引导你完成安装与认证 |

## 业务用户：三步接入

> 面向不用懂 MCP、只要能把话说清楚的同事。前提是拿到**内网版技能包**（含禅道 MCP 地址）。

### 1. 把技能包放进通用技能目录

通用技能目录是 `~/.agents/skills/`（Windows：`%USERPROFILE%\.agents\skills\`），大多数 Agent 宿主都能从这里加载技能。

```bash
# macOS / Linux
mkdir -p ~/.agents/skills && cp -r <解压目录>/rh-product-feedback ~/.agents/skills/
```

```powershell
# Windows（PowerShell）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse "<解压目录>\rh-product-feedback" "$env:USERPROFILE\.agents\skills\"
```

### 2. 对 Agent 说「帮我连上禅道」

Agent 会读技能包里的内网地址，按你用的宿主把禅道 MCP 登记进去（不用你填 IP），然后告诉你还差一步。

### 3. 写入你自己的禅道凭据

Agent 会给你一条命令，**你自己在终端执行**，输入禅道账号和令牌（禅道「个人 → 令牌」生成；没有就用密码）。凭据落在你自己机器上，Agent 不经手、看不到、也不会写进任何仓库。

之后就能直接用：

- 「设备列表导出按钮点了没反应，帮我提个 Bug」
- 「我想要一个批量导出功能，提个需求」
- 「反馈 421 现在什么状态了？谁在处理？」
- 「为什么这条反馈一直没排期？」
- 「给反馈 421 再补充一句：必须先选中至少一行设备才能复现」

技能会自动：识别反馈类型 → 补齐缺失信息 → 查重 → 生成草稿 → **等你确认后**写入禅道 → 回读校验并给出真实反馈 ID。

完整步骤见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md)。

## 管理员：内网地址与分发

- **地址从哪来**：写死在技能包内的 `config.local.json`（`mcpUrl` = 禅道 MCP 的 Streamable HTTP 地址，`zentaoWebUrl` = 禅道 Web 端地址）。该文件**不进仓库**，随内部分发包发出；仓库里只有 `config.example.json` 占位符。
- **优先用内网域名而不是 IP**：IP 随网络调整失效，也更容易被误贴到外部。
- **分发渠道**：技能包内容与渠道解耦，选一个现成的即可——内网 Git（`git clone` 后复制目录）、NAS / 对象存储（下载压缩包后解压）、公司软件中心（点安装）、终端管理（推到用户机器）。
- **分发包内容**：`skills/rh-product-feedback/`（含 `config.local.json`）与 `scripts/set-credentials.mjs`。
- **本仓库不包含任何内网地址、账号或凭据**；扫描器会跳过被 `.gitignore` 忽略的文件，但被提交的文件一律扫描。
- **禅道 MCP 侧可改进的两点**：支持 `Authorization: Bearer <令牌>` 请求头鉴权（凭据就能完全不进 Agent 上下文）；登录失败时可区分「密码错」与「账号被锁定」（避免连续重试触发锁定）。

## 开发与安装

### skills CLI（推荐）

```bash
# 安装全部技能
npx skills add xuxzh/ruihui-skills

# 只装一个技能
npx skills add xuxzh/ruihui-skills --skill rh-product-feedback

# 装到所有检测到的 Agent
npx skills add xuxzh/ruihui-skills --all
```

### 手动安装

把技能目录复制到你的 Agent 的技能目录即可：

```bash
cp -r skills/rh-product-feedback ~/.agents/skills/      # 通用
cp -r skills/rh-product-feedback ~/.claude/skills/      # Claude Code
```

## 使用

安装后在支持技能的 Agent 里直接用自然语言说事即可，例如：

- 「设备列表导出按钮点了没反应，帮我提个 Bug」
- 「我想要一个批量导出功能，提个需求」
- 「反馈 421 现在什么状态了？谁在处理？」
- 「为什么这条反馈一直没排期？」
- 「给反馈 421 再补充一句：必须先选中至少一行设备才能复现」

技能会自动：识别反馈类型 → 补齐缺失信息 → 查重 → 生成草稿 → **等你确认后**写入禅道 → 回读校验并给出真实反馈 ID。

## 前置条件：连接禅道 MCP

`rh-product-feedback` 通过禅道（ZenTao）MCP 工作，需要在你的 Agent 宿主里注册一个名为 `zentao` 的 MCP server（Streamable HTTP），并能访问禅道实例。

- 凭据放在你自己的机器上（**不写进本仓库**），优先用禅道个人令牌而不是密码。
- 本仓库不包含任何内网地址、账号或凭据。
- MCP 未登录时数据调用返回 401；技能会在会话开始时登录一次，失效后补登一次。
- 每个用户用自己的禅道账号登录，反馈单留痕在本人名下。

详见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md) 与 [`references/zentao-mcp.md`](skills/rh-product-feedback/references/zentao-mcp.md)。

## 能力边界

当前版本（v0.3.0）的能力与限制：

- **反馈优先**：新反馈统一落在禅道的反馈单（`feedback`）上，正式 Bug / 需求由人工评审后再建。
- **每用户独立账号**：用你自己的禅道账号登录，反馈留痕在本人名下；代价是**你只能看到有权限的产品与反馈**，查重只覆盖可见范围（话术里会写明「在你可见的 N 条中」）。
- **无服务端关键词检索**：查重靠分页拉取 + 客户端标题匹配，只覆盖扫描到的范围。
- **附件上传不可用**：请用文字描述，或走禅道 Web 端上传后再补充描述。
- **没有「只评论不改状态」的接口**：补充说明走「更新描述」路径；关闭 / 解决 / 删除等流转由人来做。
- **更新没有版本号 CAS**：禅道的更新接口无条件覆盖。补充说明会在写入前再读一次原文，发现被改过就停手交回你确认——这能显著降低覆盖他人内容的风险，但复核与写入之间仍可能有竞态。

## 开发与测试

无需构建，Node.js ≥ 20 即可（只用内置模块）。

```bash
# 静态校验：元数据、引用链接、硬约束覆盖、敏感信息扫描
node tests/validate-skills.mjs

# 模拟层测试：在 mock MCP 上验证写入确认、回读校验、防重复、并发冲突、真实 E2E 的写入闸门
node --test tests/e2e-mock.mjs

# 规范校验（Agent Skills 官方参考实现）
npx skills-ref validate skills/rh-product-feedback
```

真实 MCP 端到端测试需要本地配置禅道 MCP 地址与凭据，默认只跑只读验证：

```bash
node tests/e2e-live.mjs                                     # 只读

# 写入验证：三项条件缺一不可（开关 + 目标产品 + 允许写入的产品白名单）
ZENTAO_E2E_ALLOW_WRITE=1 \
ZENTAO_E2E_PRODUCT=<产品 id> \
ZENTAO_E2E_ALLOWED_PRODUCTS=<产品 id,...> \
  node tests/e2e-live.mjs                                   # 在白名单产品内写入并自动清理
```

写入前还要通过前置自检（认证成功、目标产品存在且在白名单内、反馈读取成功），任一项不满足立即中止、不写入。测试数据带 `[rh-skill-e2e]` 唯一标识，清理只处理本次创建且标识明确匹配的记录；创建超时或结果不明时按唯一标识复查、报告残留风险并以非零退出码结束。

CI（[`.github/workflows/validate-skills.yml`](.github/workflows/validate-skills.yml)）会跑静态校验、模拟层测试与规范校验；真实端到端测试需要内网禅道环境，不在 CI 中运行。

## 贡献

问题与需求用 GitHub Issues 跟踪：<https://github.com/xuxzh/ruihui-skills/issues>。

- [Issue #1](https://github.com/xuxzh/ruihui-skills/issues/1) — 禅道 MCP 能力盘点（`rh-product-feedback` 的前置调研）
- [Issue #2](https://github.com/xuxzh/ruihui-skills/issues/2) — `rh-product-feedback` v0.1.0 实施

改动请遵守仓库约定：技能目录只放技能本身、按需加载的参考文档与接入配置（`config.example.json` 与不进仓库的 `config.local.json`）；不要提交任何内网地址、账号、凭据或真实业务数据。

## 决策记录

- [ADR-0001](docs/adr/0001-每用户独立禅道账号.md) — 每用户独立禅道账号，不用共享服务账号
- [ADR-0002](docs/adr/0002-业务用户接入形态.md) — Agent 自装 MCP、地址随包分发、凭据由本人写入

## License

仓库尚未确定开源许可证，待 owner 确认后补充。在此之前按「保留所有权利」处理。
