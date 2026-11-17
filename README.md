# ruihui-skills

瑞辉（Ruihui）开源的 [Agent Skills](https://agentskills.io/) 集合。每个技能是一个独立目录，包含一个 `SKILL.md` 与按需加载的 `references/`。

| 技能 | 版本 | 说明 |
| --- | --- | --- |
| [`rh-product-feedback`](skills/rh-product-feedback) | 0.1.0 | 产品反馈助手：用自然语言把 Bug / 需求 / 优化建议提交成禅道反馈单，并支持查询反馈单、解释处理进度、补充说明 |

## 安装

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

- 凭据放在 MCP server 配置或环境变量里，**不要写进本仓库**。
- 本仓库不包含任何内网地址、账号或凭据。
- MCP 未登录时数据调用返回 401；技能会在会话开始时登录一次，失效后补登一次。

详见 [`skills/rh-product-feedback/references/zentao-mcp.md`](skills/rh-product-feedback/references/zentao-mcp.md)。

## 能力边界

当前版本（v0.1.0）的能力与限制：

- **反馈优先**：新反馈统一落在禅道的反馈单（`feedback`）上，正式 Bug / 需求由人工评审后再建。
- **共享服务账号**：MCP 用服务端配置的账号操作，禅道里的记录都留痕在该账号上；无法按对话里的终端用户做身份隔离。
- **无服务端关键词检索**：查重靠分页拉取 + 客户端标题匹配，只覆盖扫描到的范围。
- **附件上传不可用**：请用文字描述，或走禅道 Web 端上传后再补充描述。
- **没有「只评论不改状态」的接口**：补充说明走「更新描述」路径；关闭 / 解决 / 删除等流转由人来做。

## 开发与测试

无需构建，Node.js ≥ 20 即可（只用内置模块）。

```bash
# 静态校验：元数据、引用链接、硬约束覆盖、敏感信息扫描
node tests/validate-skills.mjs

# 模拟层测试：在 mock MCP 上验证写入确认、回读校验、防重复、错误分类
node --test tests/e2e-mock.mjs

# 规范校验（Agent Skills 官方参考实现）
npx skills-ref validate skills/rh-product-feedback
```

真实 MCP 端到端测试需要本地配置禅道 MCP 地址与凭据，默认只跑只读验证：

```bash
node tests/e2e-live.mjs                                     # 只读
ZENTAO_E2E_PRODUCT=<产品 id> ZENTAO_E2E_ALLOW_WRITE=1 \
  node tests/e2e-live.mjs                                   # 允许在指定产品内写入并自动清理
```

CI（[`.github/workflows/validate-skills.yml`](.github/workflows/validate-skills.yml)）会跑静态校验、模拟层测试与规范校验；真实端到端测试需要内网禅道环境，不在 CI 中运行。

## 贡献

问题与需求用 GitHub Issues 跟踪：<https://github.com/xuxzh/ruihui-skills/issues>。

- [Issue #1](https://github.com/xuxzh/ruihui-skills/issues/1) — 禅道 MCP 能力盘点（`rh-product-feedback` 的前置调研）
- [Issue #2](https://github.com/xuxzh/ruihui-skills/issues/2) — `rh-product-feedback` v0.1.0 实施

改动请遵守仓库约定：技能目录只放技能本身与按需加载的参考文档；不要提交任何内网地址、账号、凭据或真实业务数据。

## License

仓库尚未确定开源许可证，待 owner 确认后补充。在此之前按「保留所有权利」处理。
