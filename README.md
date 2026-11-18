# ruihui-skills

瑞辉（Ruihui）开源的 [Agent Skills](https://agentskills.io/) 集合。每个技能是一个独立目录，包含一个 `SKILL.md` 与按需加载的 `references/`。

| 技能 | 版本 | 说明 |
| --- | --- | --- |
| [`rh-product-feedback`](skills/rh-product-feedback) | 0.4.0 | 产品反馈助手：用自然语言把 Bug / 需求 / 优化建议提交成禅道反馈单，并支持查询反馈单、解释处理进度、补充说明；禅道 MCP 没配好时，能引导你完成安装与认证 |

## 业务用户：三步接入

> 面向不用懂 MCP、只要能把话说清楚的同事。技能包里已含禅道 MCP 地址，装完直接用。

完整步骤见 **[`docs/quick-start.md`](docs/quick-start.md)**——一页，含可直接复制的命令、三个示例和常见问题。三步概览：

1. **把技能包放进技能目录**：Claude Code 放 `~/.claude/skills/`，pi 放 `~/.agents/skills/`（Windows 对应 `%USERPROFILE%\.claude\skills\` 与 `.agents\skills\`）——把管理员发的 `rh-product-feedback` 整个目录复制进去。
2. **对 Agent 说「帮我连上禅道」**：Agent 自己从技能包里读出地址并登记禅道 MCP，**你不用填 IP，也不用改配置文件**；登记完重开一次宿主。
3. **写入你自己的禅道凭据**：Agent 给你一条命令，**你自己在终端执行**，输入禅道账号和令牌。凭据落在你自己机器上，**Agent 不会展示或外传它**——但会话登录模式下它需要读取这个文件去登录，令牌会进入本次会话上下文，所以优先用可单独撤销的禅道令牌，而不是账号密码。

之后就能直接用：

- 「设备列表导出按钮点了没反应，帮我提个 Bug」
- 「我想要一个批量导出功能，提个需求」
- 「反馈 421 现在什么状态了？谁在处理？」
- 「为什么这条反馈一直没排期？」
- 「给反馈 421 再补充一句：必须先选中至少一行设备才能复现」

技能会自动：识别反馈类型 → 补齐缺失信息 → 查重 → 生成草稿 → **等你确认后**写入禅道 → 回读校验并给出真实反馈 ID。

技术细节见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md)（连接禅道、写入凭据、各宿主配置）。

## 管理员：内网地址与分发

- **地址从哪来**：写死在技能包内的 `config.local.json`（`mcpUrl` = 禅道 MCP 的 Streamable HTTP 地址，`zentaoWebUrl` = 禅道 Web 端地址）。该文件**进仓库**、随技能包一起分发（见 [ADR-0005](docs/adr/0005-禅道地址进版本库.md)）：地址本身不是凭据，内网 IP 也不从公网可达。
- **地址用 IP 而不是域名**：公司没有内网 DNS 域名可指禅道 MCP；地址随网络调整时改 `config.local.json` 再分发一次。
- **分发渠道**：公网 `skills.sh` 为主——`npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`；备用：内网 Git（`git clone` 后复制目录）、NAS / 对象存储（下载压缩包后解压）、公司软件中心（点安装）、终端管理（推到用户机器）。
- **本仓库不包含任何账号或凭据**；扫描器允许内网地址出现在 `config.local.json`，出现在别处一律 fail。
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
cp -r skills/rh-product-feedback ~/.claude/skills/      # Claude Code
cp -r skills/rh-product-feedback ~/.agents/skills/       # pi
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

- 凭据放在你自己的机器上（**不写进本仓库**）：默认用禅道账号 + 密码，业务用户不必先去生成令牌。
- 本仓库不包含任何账号或凭据；禅道地址在 `config.local.json` 里，随包分发。
- 技能会在需要禅道数据时登录一次，失效后补登一次。**实测当前 MCP 的登录接口不校验凭据、恒以服务端固定身份对外服务**，所以「每用户独立账号」暂时由客户端保证不了（见 [zentao-mcp.md](skills/rh-product-feedback/references/zentao-mcp.md) 的「实测偏差」）。
- 每个用户用自己的禅道账号登录，反馈单留痕在本人名下（实测当前 MCP 恒以服务端身份提交，见 #7）。

详见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md) 与 [`references/zentao-mcp.md`](skills/rh-product-feedback/references/zentao-mcp.md)。

## 能力边界

当前版本（v0.4.0）的能力与限制：

- **反馈优先**：新反馈统一落在禅道的反馈单（`feedback`）上，正式 Bug / 需求由人工评审后再建。
- **每用户独立账号**：设计上是「用你自己的禅道账号登录，反馈留痕在本人名下」；但**实测当前 MCP 的登录接口不校验凭据、恒以服务端固定身份对外服务**，所以反馈单上的提交人暂时不是你本人（见 [#7](https://github.com/xuxzh/ruihui-skills/issues/7)）。你能看到的产品与反馈仍按账号权限走，查重只覆盖可见范围（话术里会写明「在你可见的 N 条中」）。
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

# 打包脚本与凭据脚本测试
node --test tests/package.mjs

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

改动请遵守仓库约定：技能目录只放技能本身、按需加载的参考文档与接入配置（`config.local.json` 存禅道地址，随包分发）；不要提交任何账号、凭据或真实业务数据。

## 决策记录

- [ADR-0001](docs/adr/0001-每用户独立禅道账号.md) — 每用户独立禅道账号，不用共享服务账号
- [ADR-0002](docs/adr/0002-业务用户接入形态.md) — Agent 自装 MCP、地址随包分发、凭据由本人写入
- [ADR-0003](docs/adr/0003-真实端到端测试的写入闸门.md) — 真实端到端测试默认只读，写入要过三道闸门
- [ADR-0004](docs/adr/0004-主宿主与首次接入链路.md) — 主宿主 Claude Code、首次接入三阶段 ≤4 次交互、会话登录是唯一凭据路径

## License

仓库尚未确定开源许可证，待 owner 确认后补充。在此之前按「保留所有权利」处理。
