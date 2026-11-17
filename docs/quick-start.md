# 快速上手：把 Bug、需求、建议提到禅道

面向业务用户。你需要三样东西：管理员分发的**内网版技能包**、**你自己的禅道账号和令牌**、**能连公司内网**。装好之后，不用记命令，直接说话就行。

## 第 1 步：把技能包放进技能目录

技能目录是 `~/.agents/skills/`（Windows：`%USERPROFILE%\.agents\skills\`）。管理员发你的压缩包解压后，里面有一个 `rh-product-feedback` 目录，**整个目录**复制进去。

macOS / Linux：

```bash
mkdir -p ~/.agents/skills && cp -R <解压目录>/rh-product-feedback ~/.agents/skills/
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse "<解压目录>\rh-product-feedback" "$env:USERPROFILE\.agents\skills\"
```

复制完检查一下：目录里应该有 `SKILL.md`、`references/`、`config.local.json`、`scripts/` 四个。少了 `config.local.json`，说明拿到的是不含内网地址的公开版，找管理员要内网版。

## 第 2 步：对 Agent 说「帮我连上禅道」

在 Agent 对话框里说：

> 帮我连上禅道，使用 rh-product-feedback 技能

Agent 会自己从技能包里读出禅道地址并登记好，**你不用填 IP，也不用改任何配置文件**。

登记完它会请你**重开一次宿主**（Claude Code 就是退出重开）。重开后，直接说你要提什么，不用再说别的。

## 第 3 步：写入你自己的禅道凭据

Agent 会给你一条命令，**你在自己的终端里执行**，输入禅道账号和令牌（令牌在禅道「个人 → 令牌」里生成，没有就用密码）。

macOS / Linux：

```bash
bash ~/.agents/skills/rh-product-feedback/scripts/set-credentials.sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\rh-product-feedback\scripts\set-credentials.ps1"
```

令牌输入时不回显，文件只有你自己能读。

写完**不用再回一句「好了」**，直接说你要提什么。凭据由你自己写入，Agent 不会展示或外传它；但为了让 Agent 替你登录，它需要读取这个文件——所以请用可以单独撤销的令牌，不要用账号密码。

## 提第一条反馈

三句话就够，剩下的 Agent 会追问：

**Bug**

> 设备管理页面点「导出」按钮没反应，帮我提个 Bug。

**需求**

> 希望设备管理支持批量导出 Excel，帮我提个需求。

**建议**

> 每次查询都要重选筛选条件，建议保存上次的筛选条件。

Agent 会依次做这些事：补齐缺的信息 → 确认属于哪个产品 → 查一下有没有重复的 → 把草稿给你看 → **等你确认** → 写进禅道 → 读回来核对 → 给你反馈单编号。

## 你应该看到什么

提交成功后，Agent 会给你这几样：

```
已提交：反馈单 #421
类型：Bug
产品：设备管理
状态：激活
提交人：你的禅道账号
```

**三类都创建的是禅道「反馈单」**，不是正式的 Bug 单或需求单——由人评审后才会转成正式单据。

之后随时可以问：

> 反馈 421 现在什么状态了？谁在处理？

> 反馈 421 再补充一句：必须先选中至少一行设备才能复现。

## 常见问题

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| Agent 说找不到这个技能 | 技能目录没放对，或宿主没重新加载 | 检查第 1 步的目录名；Claude Code 重开一次 |
| Agent 说这是不含内网的公开版 | 复制到的包里没有 `config.local.json` | 找管理员拿内网版技能包 |
| Agent 说禅道连不上 | 宿主没重开，或内网不通 | 先重开宿主；还不行就找管理员看内网地址 |
| Agent 说凭据没设置 | 第 3 步的命令还没跑 | 跑一次凭据命令，然后直接说要提什么 |
| 登录失败 | 账号或令牌不对，或账号被锁定 | 核对账号；被锁定要去禅道解锁，别反复重试 |
| Agent 说你的账号看不到某个产品 | 禅道权限没开 | 找管理员开权限，或换一个你有权限的产品 |

更多细节见 [`references/setup.md`](../skills/rh-product-feedback/references/setup.md)（技术参考）。
