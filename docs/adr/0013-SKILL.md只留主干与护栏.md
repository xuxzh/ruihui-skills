# SKILL.md 只留主干与护栏：安装、图片、话术下沉到第二入口
`rh-product-feedback` 的 `SKILL.md` 正文从 464 行降到 200 行上下：主文件只保留路由判断、写单据的共享主干、反馈单与缺陷单的差异表和 7 条硬约束；安装与连接、图片上传、完整话术与输出样例下沉到已有的 `references/`（`setup.md`、`workflow.md`、`*_templates.md`）。触发分支不变，写入禅道的行为不变。

## 考虑过的选项
- **只压缩措辞，不动结构**：没选。正文的体量主要来自结构而非措辞：反馈路径与缺陷路径各写一遍同一条七步主干（170 行里约 60 行是同义复述），硬约束 19 条又复述了正文里的规则。压措辞治不了这个。
- **把主干也下沉，主文件退化成纯路由**：没选。「写入前确认 → 写入 → 回读核对」是每次写禅道都要走的步骤，也是错一次代价最高的一步（禅道创建无幂等，盲目重试会造重复单）。它留在主文件里，Agent 读一份文件就能走完主干；拆成两跳更容易漏掉确认与回读。
- **新建 `references/connect.md` 放 Agent 视角的连接与自检**：没选。连接、凭据、宿主配置这些事实只应有一处住所；新建文件会让 `setup.md` 与它互相重复或互相引用，两份「宿主配置」迟早对不上。改为在 `setup.md` 里加一节「Agent 执行路径」——`setup.md` 本来就是这件事的家。
- **把硬约束整段移到 `references/guardrails.md`**：没选。护栏是「无论走哪条分支都要遵守」的内容，指针不保证被读到；留在主文件并压到 7 条，代价最小。
- **删掉术语表，指向仓库根的 `GLOSSARY.md`**：没选。技能包只发布 `skills/rh-product-feedback/` 目录，根目录的 `GLOSSARY.md` 不随包走，装到用户机器上的技能读不到它。术语表压到 6 个操作词留在主文件，用词与 `GLOSSARY.md` 对齐。
- **保留 500 行的行数上限**：没选。瘦身后 500 行等于没有约束。收到 220 行，并加一条「`references/` 下每个 `.md` 都必须被 `SKILL.md` 指向」，防止渐进披露建了文件没人读。

## 后果
- `SKILL.md` 的 description 压到约 350 字符（触发短语一个不少），正文约 200 行；`tests/validate-skills.mjs` 的行数上限从 500 收到 220，并新增 references 覆盖检查。
- 反馈单与缺陷单的差异（产品字段名 `product` / `productID`、正文字段 `desc` / `steps`、禅道字段默认值、项目挂载、随包默认产品、草稿声明）收进一张表，细则仍在 `bug-templates.md` 与 `feedback-templates.md`。
- 术语与 `GLOSSARY.md` 对齐：正文用「终端用户」「禅道账号」，新增「查重基线」「可靠写入路径」两个词。
- 上一版 SKILL.md 里「`desc` / `source` / `module` / `feedbackBy` 保持不填」与同段 payload 示例矛盾（`desc` 是反馈单正文，必填），改为只留 `source` / `module` / `feedbackBy` 不填。
- `bug-templates.md` 里「当前能力不支持图片」的说法已过期（[ADR-0011](0011-图片上传直连禅道RESTv2.md) 起有上传脚本），同步更正。
- 安装提示词里指向 SKILL.md「0.2 安装」的指针改为「0. 环境自检」（`docs/quick-start.md` 与 `references/setup.md` 同步）。
