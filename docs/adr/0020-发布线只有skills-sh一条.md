# 发布线只有 skills.sh 一条

仓库曾维护一个「内网包」：`scripts/build-internal-package.mjs` 把 `skills/rh-product-feedback/` 拷到 `dist/`，并生成一份包内 `config.local.json`，供内网 Git / NAS / 公司软件中心 / 终端管理这些渠道分发（[ADR-0004](0004-主宿主与首次接入链路.md)、[ADR-0009](0009-默认产品分两层.md)）。

## 为什么删掉

- **它不是发布线，只是拷贝方式**：包内内容与 skills.sh 上的完全同源（禅道地址、CLI 版本锁、随包默认值都已在仓库里的 `config.local.json`，见 [ADR-0005](0005-禅道地址进版本库.md)）。多出来的只有 `chmod` 和一段打印命令。
- **它必然漂移**：0.12.0 切换接入通道时，`dist/` 里还留着旧通道的 `zentao-client.mjs` / `zentao-query.*` / `zentao-write.mjs` / `zentao-upload.mjs` 与 `references/zentao-mcp.md`——正是升级时要清理的那批。第二条发布线的代价不是"多一次构建"，而是"构建完还得记得重发"。
- **它解决的问题不存在**：用这个技能的前提是机器既能连公网（AI 模型的 API，没有本地模型）又能连内网禅道。工具链（npm 装 `zentao-cli`、GitHub 装技能、skills CLI）全在公网那一侧，而公网可达已经由"能用 agent"这件事保证了。内网包解决的是"文件从哪来"，而公网取文件从来不是障碍。

## 后果

- 仓库里只保留一份技能内容，`dist/` 与打包脚本一并删除；`tests/package.mjs` 守住「仓库里没有第二份技能副本」。
- 所有机器的安装方式统一：`npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`，装完即有更新入口（`npx skills check` / `npx skills update rh-product-feedback`）。
- 手动拷进机器的目录（同事之间传、锁文件被删）没有更新入口——跑一次重装提示词，Agent 会重新装一份并清掉残留（[ADR-0019](0019-重装用同一段提示词由Agent自己判版本.md)）。
- 禅道地址仍随包分发（`config.local.json`）：它是唯一必须内网专属的东西，公开仓库不写内网 IP。

## 考虑过的选项

- **保留内网包并加"防落后"检查**：能解决漂移，但解决不了"两条发布线"本身——每次发版仍要记得构建、重发、通知覆盖。
- **保留内网包作为完全离线机器的兜底**：真正的离线需求不是"再打一份同样的技能包"，而是禅道 CLI 的离线 tarball（`npm pack` 连依赖一起带走）。等真有这种机器时再单独设计，现在不预设。
- **把内网 npm 镜像写进技能机制**（给 `config.local.json` 加 `npmRegistry`）：装禅道 CLI 用公网 npm 即可；内网镜像只是运维侧的加速手段，不该进技能机制（否则接入配置多一个与接入通道无关的旋钮）。
