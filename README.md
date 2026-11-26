# ruihui-skills

瑞辉（Ruihui）开源的 [Agent Skills](https://agentskills.io/) 集合。每个技能是一个独立目录，包含一个 `SKILL.md` 与按需加载的 `references/`。

| 技能 | 版本 | 说明 |
| --- | --- | --- |
| [`rh-product-feedback`](skills/rh-product-feedback) | [0.15.0](CHANGELOG.md#0150---2026-11-26) | 产品反馈助手：用自然语言把 Bug / 需求 / 优化建议提交到禅道——明确要 Bug 时直接建**正式缺陷单**（进开发流程），项目推进中的障碍登记成**项目问题**，其余建**反馈单**；三条路径都支持查询、解释处理进度、补充说明、正文带图，以及**解决 / 关闭 / 激活、改派与字段编辑（含批量）**；接入只走官方禅道 CLI，第一次接入时引导你装 CLI 与写本人凭据 |

## 业务用户：装完技能，一句话接入

> 面向只要能把话说清楚的同事：装技能、装官方禅道 CLI 都由 Agent 代办；账号密码你在 Agent 打开的**本机一次性页面**上填一次，全程不用开终端。

完整步骤见 **[`docs/quick-start.md`](docs/quick-start.md)**——一页，含可直接复制的提示词、三个示例和常见问题。概览：

> 直接发给别人（可贴进 IM / 邮件）：<https://github.com/xuxzh/ruihui-skills/blob/HEAD/docs/quick-start.md#快速开始>

1. **装技能 + 装官方禅道 CLI**：把「快速开始」里的提示词粘给你正在用的 Agent（pi、Claude Code、Codex 都行），它会装好技能（`npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`），再按技能包 `config.local.json` 里的版本锁装好官方禅道 CLI——**不用挑、不用填 IP、不用改配置文件**。
2. **在 Agent 打开的本机页面上填账号密码**：Agent 起一个只监听 `127.0.0.1` 的一次性页面，你在页面上填账号密码（或粘个人令牌）——密码只在你自己的机器上输入，不进对话、也不进命令行历史；页面当场验证并写入本机凭据。
3. **让 Agent 做接入自检**：凭据写好就能用，在 Agent 里说「验证一下禅道连接」。

> 不想让技能常驻、只想试一次：用 `npx skills use xuxzh/ruihui-skills@rh-product-feedback`（技能落在临时目录），提示词见 quick-start。

**技能有新版时**：把**同一段安装提示词**再发给同一个 Agent 就行（见 [`docs/quick-start.md`](docs/quick-start.md) 的「重装 / 更新」）——它首装和重装通用，会自己判断该更新还是重装；你的禅道凭据与官方禅道 CLI 都不在技能目录里，重装不会动到它们，重载一次宿主即可生效。

之后就能直接用——**每句前面带上「用 rh-product-feedback 技能：」**，Agent 走的就是技能流程（查重、给你看草稿、等你确认），而不是自己调禅道接口：

- 「用 rh-product-feedback 技能：设备列表导出按钮点了没反应，帮我提个 Bug」
- 「用 rh-product-feedback 技能：我想要一个批量导出功能，提个需求」
- 「用 rh-product-feedback 技能：给设备管理项目登记一个问题：第三方联调环境经常中断」
- 「用 rh-product-feedback 技能：反馈 421 现在什么状态了？谁在处理？」
- 「用 rh-product-feedback 技能：为什么这条反馈一直没排期？」
- 「用 rh-product-feedback 技能：给反馈 421 再补充一句：必须先选中至少一行设备才能复现」

技能会自动：判断该建哪种单据（要 Bug → 正式缺陷单；项目推进中的障碍 → 项目问题；其余 → 反馈单）→ 补齐缺失信息 → 查重 → 生成草稿 → **等你确认后**写入禅道 → 回读校验并给出真实单据编号 → 附一条可点开的禅道直达链接。

技术细节见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md)（连接禅道、写入凭据、默认产品、各宿主配置）。

## 管理员：内网地址与分发

- **地址从哪来**：写在技能包内的 `config.local.json`（`zentaoWebUrl` = 禅道站点地址，同时用于换令牌与拼单据链接；`zentaoCli` = 官方禅道 CLI 的版本锁；`mcpUrl` = 团队自研禅道 MCP 的地址）。该文件**进仓库**、随技能包一起分发（见 [ADR-0005](docs/adr/0005-禅道地址进版本库.md)）：地址本身不是凭据，内网 IP 也不从公网可达。`mcpUrl` 只是留给终端用户自己手动查看用的地址来源——团队自研禅道 MCP 已降级为「给人手动查看」，技能代码不读它、不依赖它、不登记它。
- **地址用 IP 而不是域名**：公司没有内网 DNS 域名可指禅道；地址随网络调整时改 `config.local.json` 再分发一次。
- **分发渠道**：只有公网 `skills.sh` 一条——`npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`。装完就有更新入口（`npx skills check` / `npx skills update rh-product-feedback`）。不再维护第二份拷贝渠道（内网包 / NAS / 软件中心推送）：内容与 skills.sh 上的完全相同，却多出一条必然漂移的发布线。
- **本仓库不包含任何账号或凭据**；扫描器允许内网地址出现在 `config.local.json`，出现在别处一律 fail。
- **CLI 版本升级走发版流程**：改 `config.local.json` 的 `zentaoCli.version` → 跑一次接入自检 → 重新分发（步骤见下面的[「发版」](#发版)）。业务用户不要自己 `npm i -g zentao-cli@latest`，技能也不在运行时升级。

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

### 手动安装（不推荐）

把技能目录复制到你的 Agent 的技能目录也能用：

```bash
cp -r skills/rh-product-feedback ~/.claude/skills/      # Claude Code
cp -r skills/rh-product-feedback ~/.agents/skills/       # pi
```

但这样装的没有更新入口（`skills update` 找不到它）。要用就用上面的 `npx skills add`。

## 使用

安装后在支持技能的 Agent 里直接用自然语言说事即可（带上技能名，让 Agent 走技能流程），例如：

- 「用 rh-product-feedback 技能：设备列表导出按钮点了没反应，帮我提个 Bug」
- 「用 rh-product-feedback 技能：我想要一个批量导出功能，提个需求」
- 「用 rh-product-feedback 技能：给设备管理项目登记一个问题：第三方联调环境经常中断」
- 「用 rh-product-feedback 技能：反馈 421 现在什么状态了？谁在处理？」
- 「用 rh-product-feedback 技能：为什么这条反馈一直没排期？」
- 「用 rh-product-feedback 技能：给反馈 421 再补充一句：必须先选中至少一行设备才能复现」

技能会自动：判断该建哪种单据（要 Bug → 正式缺陷单；项目推进中的障碍 → 项目问题；其余 → 反馈单）→ 补齐缺失信息 → 查重 → 生成草稿 → **等你确认后**写入禅道 → 回读校验并给出真实单据编号 → 附一条可点开的禅道直达链接。

## 前置条件：官方禅道 CLI + 本人凭据

`rh-product-feedback` 只走**一条**接入通道：官方禅道 CLI（npm 包 `zentao-cli`，版本锁在技能包 `config.local.json` 的 `zentaoCli`）。没有第二条通道，也不需要登记禅道 MCP（`config.local.json` 里的 `mcpUrl` 只是给人手动查看用的地址来源，技能不读它）。

- 前置是 Node.js 18+ 与 `zentao` 命令在 PATH 里；版本对不上时按版本锁重装。
- 凭据放在你自己的机器上（**不写进本仓库**）：默认用禅道账号 + 密码，业务用户不必先去生成令牌。
- 本仓库不包含任何账号或凭据；禅道站点地址在 `config.local.json` 里，随包分发。
- 随包入口脚本用你的凭据换一个**属于你账号**的禅道令牌，经环境变量注入 CLI 子进程。密码与令牌不进命令行参数、不进对话（见 [zentao-cli.md](skills/rh-product-feedback/references/zentao-cli.md) 的「认证」）。
- 每个用户用自己的禅道账号令牌操作，反馈单、缺陷单与项目问题都留痕在本人名下。

详见 [`skills/rh-product-feedback/references/setup.md`](skills/rh-product-feedback/references/setup.md) 与 [`references/zentao-cli.md`](skills/rh-product-feedback/references/zentao-cli.md)。

## 能力边界

当前版本（[v0.15.0](https://github.com/xuxzh/ruihui-skills/releases/tag/v0.15.0)）的能力与限制：

- **接入通道是官方禅道 CLI**（0.12.0 起）：此前的随包直连脚本与宿主里的禅道 MCP 工具已下线。旧版机器按 [`docs/quick-start.md`](docs/quick-start.md) 的「重装 / 更新」走一遍即可：同一段提示词，Agent 自己判版本、自己清残留，不用业务用户做任何选择。

- **安装交给当前的 Agent**：装技能用 skills CLI，装官方禅道 CLI 也由你在用的那个 Agent 自己做（按接入配置的版本锁），技能包里不写死宿主清单。

- **凭据也在这个对话框里填**（0.13.0 起）：Agent 起一个只监听 `127.0.0.1` 的一次性页面，你在自己的浏览器里填账号密码（或粘个人令牌），页面当场验证并写本机凭据，写完自关——不用切到终端，密码不进对话、也不进命令行历史（见 [ADR-0022](docs/adr/0022-写凭据走本机一次性页面.md)）。远程 SSH 或没有图形界面时仍可用 `set-credentials.sh` 兜底。

- **读写都走随包入口脚本**：`scripts/zentao.mjs` 负责换令牌、注入官方禅道 CLI、投影输出——读（产品、项目、列表、详情）与写（建单、更新、传图）都是它的子命令，只发一次、写完回读，保留「等你确认再写」的链路；查重助手 `scripts/zentao-dedupe.mjs` 只做中文切词。原始 JSON、凭据与令牌都不进上下文。宿主里的禅道 MCP 工具是服务端固定身份，只适合查看，不用来建单（见 [ADR-0017](docs/adr/0017-用官方禅道CLI替换自研接入通道.md)）。

- **三种对象并存**（见 [ADR-0025](docs/adr/0025-把项目问题纳入技能作为第三种对象.md)）：明确要 Bug / 缺陷 / 报错时，直接建禅道**正式缺陷单**（进开发流程，草稿里会写明这一点）；需求、建议、说不清是不是 bug 的，建**反馈单**；项目推进中的障碍、需求变更、环境依赖，按你的要求登记成挂在项目下的**项目问题**。一次诉求只建一张单，不会同时给你一张反馈单和一张缺陷单（缺陷路径见 [ADR-0008](docs/adr/0008-反馈路径与缺陷路径并存.md)）。项目问题第一版只做**登记与查询**：CLI 没有 update / resolve / close / activate，流转与改字段走禅道网页端；物理删除不开放。
- **默认产品分两层**：随包默认产品写在技能包的接入配置里（管理员预置、全公司共享一份，用的时候跟用户确认一句）；本机默认产品存在你自己的机器上（你自己设的，直接用，不再问）。两者都只是默认值，你明说的产品永远优先；默认产品当前不可见时会如实说明并列出你能看到的产品。
- **每用户独立账号**：随包脚本用你自己的禅道账号令牌提交，单据留痕在本人名下，提完回读核对提交人。你能看到的产品与单据按账号权限走，查重只覆盖可见范围（话术里会写明「在你可见的 N 条中」）。
- **无服务端关键词检索**：查重靠入口脚本全量拉取 + 客户端标题匹配，只覆盖扫描到的范围；服务端分页异常时如实标注「覆盖不完整」（见 issue #25）。
- **正文可以带图片**：你粘图或给图片路径，技能用入口脚本的 `file-create` 子命令（官方 CLI 的 `file create`，单文件上限 50 MiB）把图片传到禅道，再把图片引用写进反馈单或缺陷单的正文。顺序是「先建单 → 再传图 → 再更新正文」——禅道的图片必须挂在已存在的单据上。图片只支持反馈单与缺陷单，不支持 base64 内联。
- **没有「只评论不改状态」的接口**：补充说明走「更新正文」路径（`append` 模式）。
- **生命周期流转与字段编辑**（0.14.0 起，见 [ADR-0024](docs/adr/0024-放开缺陷与反馈生命周期流转并按操作分级护栏.md)）：缺陷单可 `bug-resolve` / `bug-close` / `bug-activate`，反馈单可 `feedback-close` / `feedback-activate`；`bug-update` / `feedback-update` 多了 `edit` 模式做改派、改优先级 / 严重程度 / 类型 / 项目 / 影响版本，改标题或正文带 `expectedTitle` / `expectedBody` 做写前 CAS 复核。全部经入口脚本做格式校验、状态预检、单次写入与写后回读；**物理删除不开放**（要删单走禅道网页端）。
- **批量操作**：`--ids` 单批最多 20 条，仅开放状态流转与非正文统一字段编辑；先 `--preview` 看三栏清单，确认后串行执行并按「成功 / 跳过 / 失败」汇报，失败项不自动重试（可加 `--fail-fast`）。单条明确的可逆流转免二次确认，批量、改正文 / 标题与 AI 推断参数的操作必须先确认——规则见 [lifecycle.md](skills/rh-product-feedback/references/lifecycle.md)。
- **更新没有版本号 CAS**：禅道的更新接口无条件覆盖。补充说明与编辑模式会在写入前再读一次原文，发现被改过就停手交回你确认——这能显著降低覆盖他人内容的风险，但复核与写入之间仍可能有竞态。
- **8.7 的反馈详情权限**（0.15.0 起）：本实例的 v2 反馈详情接口对所有账号返回 403，技能内置临时绕行——读走 v1 回退、补充说明走直连更新；服务端把权限修好后（issue #30），用 `ZENTAO_FEEDBACK_V1_FALLBACK=0` 与 `ZENTAO_FEEDBACK_DIRECT_UPDATE=0` 关掉即可回到纯官方 CLI 路径。

## 开发与测试

无需构建，Node.js ≥ 20 即可（只用内置模块）。

```bash
# 静态校验：元数据、引用链接、硬约束覆盖、敏感信息扫描
node tests/validate-skills.mjs

# 模拟层测试：在假禅道 API v2 上验证读取、写入确认、回读校验、防重复、真实 E2E 的写入闸门
node --test tests/e2e-mock.mjs

# 技能目录与随包脚本测试（旧脚本已下线、仓库里没有第二份副本）
node --test tests/package.mjs

# 接入配置的 CLI 版本锁与接入提示词
node --test tests/setup-cli-pin.mjs

# 更新日志脚本：段落抽取、按提交出发版草稿、版本号建议
node --test tests/release-notes.mjs

# 入口脚本的读 / 写 / 查重 / 传图通道（装官方禅道 CLI 后才有意义，没装按 skip 计）
for f in tests/zentao-cli-*.mjs; do node --test "$f"; done

# 既有读 / 写通道用例（随包入口脚本已接手）
node --test tests/queryer.mjs
node --test tests/write.mjs
node --test tests/skill-flow.mjs

# 图片上传测试：在假禅道上验证上传、引用生成、失败处理、凭据不外泄
node --test tests/upload.mjs

# 本机写入页测试：一次性地址、验证后落盘、失败不留凭据、连续失败停手、凭据不外泄
node --test tests/connect.mjs

# 规范校验（Agent Skills 官方参考实现）
npx skills-ref validate skills/rh-product-feedback
```

真实端到端测试需要内网禅道地址与本人凭据，默认只跑只读验证：

```bash
node tests/e2e-live.mjs                                     # 只读

# 写入验证：三项条件缺一不可（开关 + 目标产品 + 允许写入的产品白名单）
ZENTAO_E2E_ALLOW_WRITE=1 \
ZENTAO_E2E_PRODUCT=<产品 id> \
ZENTAO_E2E_ALLOWED_PRODUCTS=<产品 id,...> \
  node tests/e2e-live.mjs                                   # 在白名单产品内写入并自动清理
```

写入前还要通过前置自检（认证成功、目标产品存在且在白名单内、反馈读取成功），任一项不满足立即中止、不写入。测试数据带 `[rh-skill-e2e]` 唯一标识，清理只处理本次创建且标识明确匹配的记录；创建超时或结果不明时按唯一标识复查、报告残留风险并以非零退出码结束。

项目问题的写入闸门用同一套开关加项目维度：`ZENTAO_E2E_PROJECT` + `ZENTAO_E2E_ALLOWED_PROJECTS`（目标项目必须在白名单内）。CLI 对 `issue` 没有删除动作，自动化闭环无法清理测试记录，所以第一版不跑项目问题的真实写入，闸门只供人工授权验证使用。

CI（[`.github/workflows/validate-skills.yml`](.github/workflows/validate-skills.yml)）会跑静态校验、模拟层测试、技能目录与随包脚本测试、入口脚本各通道测试与规范校验；真实端到端测试需要内网禅道环境，不在 CI 中运行。

### 发版

每个技能版本发一次版：产出 `v<技能版本>` 标签与同名的 GitHub Release。安装来源始终是 main 的最新提交，Release 只做记录；main 上尚未发版的改动记在 `CHANGELOG.md` 的 `[Unreleased]` 段。

1. **写定该版本段落**：`node scripts/release-notes.mjs --draft` 按上个标签以来改动技能目录的提交出一份草稿（附版本号建议）；把草稿改写成行为层面的条目、合并同类项，与 `[Unreleased]` 里平时记下的合并，再把 `[Unreleased]` 改成 `## [<版本>] - <日期>` 并在文件底部加这一版的对比链接。
2. **推进版本号三处**：`skills/rh-product-feedback/SKILL.md` 的 `metadata.rh-version`、`CHANGELOG.md` 最新段落、README 的两处版本（技能表格与「当前版本」）。
3. **本地校验后提交到 main**：`node tests/validate-skills.mjs`，等 CI 通过。
4. **打标签并推送**：`git tag -a v<版本> -m "v<版本>"`，`git push origin v<版本>`。`release` 工作流会校验「标签 = 标签提交里的 `rh-version` = 更新日志段落」，通过后用该段落生成 Release。

标签发出后保持不动，修正走新的版本。全部版本见 [CHANGELOG.md](CHANGELOG.md) 与 [Releases](https://github.com/xuxzh/ruihui-skills/releases)。

**让 Agent 代跑**：把下面这段发给 Agent。草稿改定后它先给你过目，你确认后它才提交：

> 按 README「发版」小节给 rh-product-feedback 发一个新版：先跑 `node scripts/release-notes.mjs --draft` 拿草稿，对照 `git log v<上一个标签>..HEAD -- skills/rh-product-feedback` 与技能目录的差异，把草稿改写成行为层面的条目并合并同类项，需要时加一行「升级须做」，然后发给我过目。我确认后：把段落写进 `CHANGELOG.md`，推进 `SKILL.md`、`CHANGELOG.md`、README 三处版本号，跑 `node tests/validate-skills.mjs`，通过后提交到 main，在这个提交上打 `v<版本>` 标签并推送，等 `release` 工作流跑完把 Release 链接发给我。

## 贡献

问题与需求用 GitHub Issues 跟踪：<https://github.com/xuxzh/ruihui-skills/issues>。

- [Issue #1](https://github.com/xuxzh/ruihui-skills/issues/1) — 禅道 MCP 能力盘点（`rh-product-feedback` 的前置调研）
- [Issue #2](https://github.com/xuxzh/ruihui-skills/issues/2) — `rh-product-feedback` v0.1.0 实施

改动请遵守仓库约定：技能目录只放技能本身、按需加载的参考文档与接入配置（`config.local.json` 存禅道地址，随包分发）；不要提交任何账号、凭据或真实业务数据。

## 更新日志

每个技能版本的改动记录在 [CHANGELOG.md](CHANGELOG.md)，GitHub 上对应 [Releases](https://github.com/xuxzh/ruihui-skills/releases)。

## 决策记录

- [ADR-0001](docs/adr/0001-每用户独立禅道账号.md) — 每用户独立禅道账号，不用共享服务账号
- [ADR-0002](docs/adr/0002-业务用户接入形态.md) — Agent 自装 MCP、地址随包分发、凭据由本人写入（历史决策，已被 ADR-0017 取代）
- [ADR-0003](docs/adr/0003-真实端到端测试的写入闸门.md) — 真实端到端测试默认只读，写入要过三道闸门
- [ADR-0004](docs/adr/0004-主宿主与首次接入链路.md) — 主宿主 Claude Code、首次接入三阶段 ≤4 次交互、会话登录是唯一凭据路径
- [ADR-0005](docs/adr/0005-禅道地址进版本库.md) — 禅道地址进版本库、技能走公网分发、凭据默认账号密码
- [ADR-0006](docs/adr/0006-安装脚本与首次接入.md) — 安装脚本与首次接入：一条命令装好
- [ADR-0007](docs/adr/0007-技能触发的安装入口.md) — 技能触发的安装入口：业务用户不再手敲长命令
- [ADR-0008](docs/adr/0008-反馈路径与缺陷路径并存.md) — 反馈路径与缺陷路径并存
- [ADR-0009](docs/adr/0009-默认产品分两层.md) — 默认产品分两层
- [ADR-0010](docs/adr/0010-读走随包查询器写走MCP工具.md) — 读走随包查询器，写走 MCP 工具（历史决策，已被 ADR-0017 取代）
- [ADR-0011](docs/adr/0011-图片上传直连禅道RESTv2.md) — 图片上传直连禅道 REST v2（历史决策，已被 ADR-0017 取代）
- [ADR-0012](docs/adr/0012-安装与登记交给当前Agent.md) — 安装与登记交给当前 Agent：程序不写死宿主清单
- [ADR-0013](docs/adr/0013-SKILL.md只留主干与护栏.md) — SKILL.md 只留主干与护栏：安装、图片、话术下沉到第二入口
- [ADR-0014](docs/adr/0014-速查段自足与硬上限.md) — 速查段自足与硬上限
- [ADR-0015](docs/adr/0015-读写都走随包脚本写入带用户令牌.md) — 读写都走随包脚本，写入带用户令牌（历史决策，已被 ADR-0017 取代）
- [ADR-0016](docs/adr/0016-默认负责人跟产品QD走且可配置.md) — 默认负责人跟产品 QD 走且可配置
- [ADR-0017](docs/adr/0017-用官方禅道CLI替换自研接入通道.md) — 用官方禅道 CLI 替换自研接入通道（当前唯一通道）
- [ADR-0018](docs/adr/0018-随包默认负责人改为不指派.md) — 随包默认负责人改为不指派
- [ADR-0019](docs/adr/0019-重装用同一段提示词由Agent自己判版本.md) — 重装用同一段提示词，由 Agent 自己判版本
- [ADR-0020](docs/adr/0020-发布线只有skills-sh一条.md) — 发布线只有 skills.sh 一条（删掉内网包）
- [ADR-0021](docs/adr/0021-缺Nodejs时由Agent装.md) — 缺 Node.js 时由 Agent 装，优先用已有的版本管理器
- [ADR-0022](docs/adr/0022-写凭据走本机一次性页面.md) — 写凭据走本机一次性页面，不再把人踢去终端
- [ADR-0023](docs/adr/0023-提单话术必须点名技能.md) — 提单话术必须点名技能：宿主按 description 路由，不点名就绕开整条流程
- [ADR-0024](docs/adr/0024-放开缺陷与反馈生命周期流转并按操作分级护栏.md) — 放开缺陷与反馈生命周期流转并按操作分级护栏（当前）

## License

仓库尚未确定开源许可证，待 owner 确认后补充。在此之前按「保留所有权利」处理。
