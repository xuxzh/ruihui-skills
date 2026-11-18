# 快速上手：把 Bug、需求、建议提到禅道

面向**业务用户**。装法是**一条命令**，装完不用记命令，直接说话就行。

> 三步速查
>
> 1. 装技能：`npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global`
> 2. 跑安装脚本：`bash ~/.claude/skills/rh-product-feedback/scripts/install.sh`（它会登记禅道 MCP，并让你输入自己的禅道账号和密码）
> 3. 退出重开一次 Agent，说「验证一下禅道连接」；之后直接说要提什么。

---

## 第 1 步：装技能

```bash
npx skills add xuxzh/ruihui-skills --skill rh-product-feedback --global
```

它会自动装到你的 Agent 上：

| 你用的 | 装到这里（macOS / Linux） | Windows |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/rh-product-feedback/` | `%USERPROFILE%\.claude\skills\rh-product-feedback\` |
| pi | `~/.agents/skills/rh-product-feedback/` | `%USERPROFILE%\.agents\skills\rh-product-feedback\` |

不想用命令行，也可以从 GitHub 下载技能包、解压后按上面的路径放好——第 2 步的脚本就在包里。

## 第 2 步：跑安装脚本

```bash
# Claude Code
bash ~/.claude/skills/rh-product-feedback/scripts/install.sh
```

```powershell
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\rh-product-feedback\scripts\install.ps1"
```

用 pi 的话，把路径里的 `.claude` 换成 `.agents`。

脚本一次做完三件事：

1. **登记禅道 MCP**：从技能包里读地址，登记到你的 Agent。**你不用填 IP，也不用改任何配置文件。**
2. **让你输入自己的禅道账号和密码**：密码不回显，写在你自己的机器上，只有你能读。
3. **提示你重启 Agent**：Claude Code 退出重开；pi 执行 `/reload`。

> **先退出 Claude Code 再跑这条命令。** 运行中的 Claude Code 会回写 `~/.claude.json`，可能把你刚登记的条目覆盖掉。脚本发现宿主还在跑会直接停下提示你。

脚本可以重复跑：装好的部分会跳过，地址一致就什么都不改。

## 第 3 步：重启 Agent，验证连接

重开后，在 Agent 的对话框里说：

> 验证一下禅道连接

它会登录禅道、读一次产品列表（这份列表就是你能提交到的范围），并如实告诉你凭据此刻起没起作用。

**写完凭据不用再回一句「好了」**，直接说要提什么就行。

## 提第一条反馈

三句话就够，剩下的 Agent 会追问：

**Bug**

> 设备管理页面点「导出」按钮没反应，帮我提个 Bug。

**需求**

> 希望设备管理支持批量导出 Excel，帮我提个需求。

**建议**

> 每次查询都要重选筛选条件，建议保存上次的筛选条件。

Agent 会依次做这些事：补齐缺的信息 → 确认属于哪个产品 → 查一下有没有重复的 → 把草稿给你看 → **等你确认** → 写进禅道 → 读回来核对 → 给你反馈单编号。

**它一定会先给你看草稿、等你确认**。没确认之前不会写进禅道；你说「取消」就一条都不会留。

## 你应该看到什么

提交成功后，Agent 会给你这几样：

```
已提交：反馈单 #421
类型：Bug
产品：设备管理
状态：激活
```

**三类都创建的是禅道「反馈单」**，不是正式的 Bug 单或需求单——由人评审后才会转成正式单据。

想核验它是不是真的写进去了，随时问：

> 反馈 421 现在什么状态了？谁在处理？

> 反馈 421 再补充一句：必须先选中至少一行设备才能复现。

### ⚠️ 关于「提交人」：目前不是你本人

禅道 MCP 现在是**用一个固定的服务端账号**提交所有反馈的，所以反馈单上的「提交人」不是你，而是那个服务端账号（已记录在 [#7](https://github.com/xuxzh/ruihui-skills/issues/7)，MCP 侧修好后才会变成你本人）。

所以：

- 想让别人知道这条是你提的，**在描述里写上你的姓名或工号**，或者直接跟评审的人说一声。
- 别把「提交人」那一栏当成自己的名字去看——它现在对所有人都是同一个。
- 你自己的账号密码**照常输入**：等 MCP 改成按用户凭据登录时，凭据已经在机器上，直接生效，不用重装。

## 常见问题

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| 脚本说没有检测到宿主 | Claude Code 和 pi 都没装 | 先装好其中一个再跑脚本 |
| 脚本说 Claude Code 正在运行 | 运行中的宿主会覆盖配置 | 退出 Claude Code 再跑（或加 `--force`） |
| 装完连不上禅道 | 宿主回写覆盖了配置 | 在 Agent 里说「更新禅道地址」，它只改一个键；或再跑一次脚本 |
| 登录失败 | 账号或密码不对 | 核对后重跑脚本；不要反复试，连续失败可能锁号 |
| 装完 Agent 没反应 | 技能刚装上，宿主还没加载 | Claude Code 退出重开；pi 执行 `/reload` |
| 登录成功了，但提交人是另一个人 | 当前 MCP 恒以服务端账号服务 | 见上面「关于提交人」 |
| Agent 说你的账号看不到某个产品 | 禅道权限没开 | 找管理员开权限，或换一个你有权限的产品 |
| Agent 一直追问细节 | 缺了它判断分类、复现或验收要用的信息 | 一次答完它问的那几条；确实不知道就说「不知道」，它会写「用户未提供」，不会替你编 |

## 不归你管的事

- 关闭、删除、解决反馈单，以及指派负责人——都由人来做，Agent 只提交内容和读取状态。
- 截图上传：目前传不上去，请用文字描述，或走禅道 Web 端上传后再让 Agent 补充描述。

---

**实施人员 / 管理员**：批量部署、打包分发、各宿主差异与故障排查见 [`skills/rh-product-feedback/references/setup.md`](../skills/rh-product-feedback/references/setup.md)（技术参考）；打包命令见 [`README.md`](../README.md) 的「管理员：禅道地址与分发」。
