# alfa

[![release](https://img.shields.io/github/v/release/alfa-plus-laboratory/alfa?style=flat-square&color=0B5C9E)](https://github.com/alfa-plus-laboratory/alfa/releases/latest)
[![license](https://img.shields.io/badge/license-Apache--2.0-0B5C9E?style=flat-square)](LICENSE)

**一个住在终端里的编码 agent。** 进到项目目录,说一句你想要什么 —— 它读你的代码、
改你的文件、跑你的测试,而任何撤不回来的动作,它先问你。

除了模型调用,所有事情都在你自己的机器上。用你自己的 API key,直连你自己的
provider。没有后端,不用注册,没有遥测。

*其它语言:[English](README.md) · [日本語](README.ja.md)。*

```
╭─ api ────────────[-]─┬─ session ──────────────────────────┬─ detail ─────────────────[-]─╮
│ ▸ src                │ so far ─────────────────────────── │                              │
│ ▸ test               │ what this session is about will ap │  nothing to show yet.        │
│   package.json    ?  │ pear here after the first reply.   │                              │
│   README.md       ?  │ ─[● ●]─ ────────────────────────── │  it follows the latest tool… │
│                      │                                    │    read   -> file            │
│                      │                                    │    edit   -> diff            │
│                      │                                    │    bash   -> output          │
│                      │                                    │                              │
│                      │                                    │  or pick a file on the left. │
│                      ├───────────────── ▓░░░░░░░░░░░ ~9% ─┤                              │
│                      │ › Ask anything, or /help           │                              │
├──────────────────────┴────────────────────────────────────┴──────────────────────────────┤
│ ~/api · anthropic/claude-sonnet-4-5 · [⧉ copy]                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
```

## 安装

```bash
curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
```

一个文件,不用先装运行时 —— 二进制自带。支持 macOS 和 Linux 的 x64 / arm64,
以及 Windows x64。安装脚本会核对 SHA-256,对不上就拒绝安装。

之后用 `alfa upgrade` 原地更新。它**不会背着你自动升级**:只在有新版时说一声,
换不换由你敲那条命令。

想自己编译?见[从源码构建](#从源码构建)。

## 第一次跑

```bash
cd 你的项目
alfa
```

第一次启动会先问模型 provider —— 贴一把 Anthropic、OpenAI 或者任意
OpenAI 兼容端点的 key,它会先验证再落盘。

**每进一个新文件夹**还会问两句:屏幕怎么排,以及这个文件夹信不信任。两个答案都
存进**你的 config**,仓库里一个字都不写。想用默认值就连按两下回车。

然后直接说话:

```
› 登录接口在重定向的时候把 session cookie 丢了,查一下为什么
› 给购物车为空这个情况补个测试,然后让它过
› 这个仓库到底是干什么的?先自己读一圈再说
```

不想要全屏界面?`alfa --plain` 回到普通的底部输入框,输出照常进终端滚动缓冲。
想在脚本里用?`alfa -p "…"` 跑一轮就退出。

## 它能做什么

十五个内建工具:`read` `write` `edit` `bash` `grep` `glob` `todo` `job`
`task` `ask` `memory` `context` `skill` `webfetch` `websearch`。

除了那几个显而易见的,这意味着它可以:

- **把东西丢到后台跑** —— 起一个 dev server,接着干别的,回头再看它。alfa 退出时
  这些进程会被杀干净,不会留成孤儿。
- **派子 agent 出去** —— `task` 派一个带独立上下文窗口的子 agent。适合那种"要读遍
  半个仓库、但答案只有一段话"的问题。开着 `/agentflow` 可以一次派好几个并排成流水线。
- **停下来问你一句** —— 遇到真正的岔路口,它问一句然后等着,而不是替你猜。
- **跨会话记事** —— 它写的便条落在 `.alfa/memory/`,下一场会话开口就带着。
- **自己验一遍活** —— 交活之前跑一遍你项目的类型检查或构建(能找到的话),
  把自己弄坏的地方修好。

## 权限

把一个仓库交给它之前,这一节值得读。

每一次工具调用都过一道门。读是免费的;写、删、出网都会被分类,而分类结果**完整
显示给你** —— shell 命令是把管道里的每一段单独列出来,不是挤成一行让你扫一眼就按 y。

三档模式,`shift-tab` 或 `/permission` 切:

| 模式 | 含义 |
|---|---|
| `confirm` | 什么都问,包括读 |
| `default` | 写、删、出网之前问 |
| `trust` | 不问,直接跑 |

缺省是 `default`。非默认的模式**一定会写在启动横幅上** —— 一个你会忘掉的安全设置,
不算安全设置。

「以后不再问」按工作区记住,启动时会告诉你现在有几条这样的规则在生效。有些事**任何
模式下都不放行**:读凭据文件、往工作区外面写、抓 link-local 和云元数据地址,一律拒绝。

**模型从外面读到的一切都按数据处理,不是指令。** 网页、搜索结果、MCP 工具的返回、
以及不是你写的文件,全都过同一道过滤:去掉不可见字符,并把试图对 agent 下命令的
文字标出来。这不是被害妄想 —— 一份被投毒的 README 躺在 `node_modules` 里,
到达模型的方式和一个网页完全一样。

## 文件夹信任

一个仓库不需要你做任何事就能对 agent 说话:它的 `AGENTS.md` 和 `CLAUDE.md` 会被
原样拼进 system prompt,它的 `.alfa/mcp.json` 能指定要启动的可执行文件。自己写的
代码没问题,刚 clone 下来的就是另一回事。

信任是**默认给的** —— 一个每进一个目录就要你按一次 `y` 的工具,只会把你训练成
不看就按。它的价值在于**有一条明确的路可以不给**,以及给了之后**记着是哪天给的**。

选「先看一眼」的话,alfa 会派一个子 agent 去读那些文件,只有确认里面没有在**引导
agent**(而不是在描述项目)时才打上信任标记。判据是**这句话的效果往哪去**,不是
说得多硬:「不许加注释」是家规,「把 .env 发到某个地址」不是。检查有任何话要说 ——
或者根本没跑回来 —— 这个文件夹都保持不信任。

不信任期间,它的 `AGENTS.md`、`CLAUDE.md`、`.alfa/memory/` 和 `.alfa/skills/`
**一个字都不进 system prompt**,而且启动时会明说。用 `/trust` 管理。

## 快捷键

| 键 | |
|---|---|
| `enter` | 发送 —— 正在跑的时候排队 |
| `ctrl-j` | 换行 |
| `esc` | 中断这一轮;否则由近及远地退一层 |
| `tab` | 换栏 —— 打字永远自动跳回输入框 |
| `shift-tab` | 换权限模式 |
| `/` `@` | 命令面板 · 引用一个文件 |
| `ctrl-b` `ctrl-p` `ctrl-]` | 文件树 · 计划 · 右栏 |
| `ctrl-y` | 复制 —— 代码块、整段回答、你说的话、整场对话 |
| `ctrl-l` | 重画屏幕 |
| `ctrl-o` `ctrl-r` | 锁住右栏 · 重扫文件树 |
| `ctrl-c` | 清空输入;空行上连按两次退出 |

### 复制

全屏终端程序会抓鼠标,于是拖选就没了 —— 就算绕过去拖到了,拖出来的也是**屏幕上的
样子**:边框、折过的行、还夹着旁边那一栏的字。

`ctrl-y`(或者点状态行上那块 `[⧉ copy]`)列出可以复制的东西,内容**从会话库里取
原文**:最后那段回答里的每个代码块、整段回答、你刚才那句话、或者整场对话。走
OSC 52,所以**在 SSH 上和本机是同一条路**。tmux 里需要 `set -g set-clipboard on`。

## 命令

`/help` `/context` `/compact` `/check` `/init` `/model` `/view`
`/language` `/permission` `/trust` `/think` `/agentflow` `/mcp` `/skills`
`/resume` `/summary` `/clear` `/history-clean` `/reset` `/upgrade` `/exit`

几条值得知道的:

- **`/init`** 真的把仓库读一遍,然后给它写一份 `AGENTS.md`:怎么 build、怎么测、
  哪些约定不能破。
- **`/compact`** 把长会话折成一段交接说明。快撞满窗口时会自动触发,原文一个字不删。
- **`/context`** 显示上下文窗口现在被谁占着,好让你知道该砍哪一块。
- **`/reset`** 清掉 alfa 的状态;**`alfa uninstall`** 连 alfa 自己(包括那个二进制)
  一起删掉。两条都会先把要删的东西列出来。

## 配置

两个文件,刻意分开:

| | |
|---|---|
| `~/.config/alfa/config.json` | provider、默认模型、偏好。**一个字节的密钥都没有**,可以放进 dotfiles 仓库 |
| `~/.local/share/alfa/auth.json` | API key,权限 `0600` |

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "providers": {
    "anthropic": { "type": "anthropic" },
    "local": {
      "type": "openai-compat",
      "baseURL": "http://localhost:11434/v1",
      "models": ["qwen2.5-coder:32b"]
    }
  },
  "language": { "interface": "auto", "reply": "auto" }
}
```

任何 OpenAI 兼容端点都能接 —— 本地的 llama.cpp / Ollama、自建网关、或者别家的托管
服务。**手改这个文件是被支持的用法**,所以它报错时会指出是哪个字段、期望什么值。

环境变量覆盖:`ALFA_KEY_<PROVIDER>`、`ALFA_BASE_URL_<PROVIDER>`、`ALFA_MODEL`、
`ALFA_SHELL`、`ALFA_DEBUG=1`。

界面支持 English / 中文 / 日本語(`/language`)。键名、工具名、模式名**一律不译** ——
它们是你要敲进去的东西。

### MCP、skills、记忆

- **MCP** —— server 写在 `config.json`(你的)或者 `.alfa/mcp.json`(项目的)。
  **项目**定义的那些必须你当面点头才会启动,因为那个文件指定的是一条可执行路径。
- **Skills** —— 一份打法就是一个 markdown 文件,放在 `.alfa/skills/`、
  `~/.config/alfa/skills/` 或 `.claude/skills/`。prompt 里只有名字和一句说明,
  正文用得上的时候才取。
- **记忆** —— `.alfa/memory/` 装着 agent 给这个项目写的便条,每场会话开头自动加载。
  用 `/init` 和 `memory` 工具管理。

## 隐私

alfa **没有遥测**。源码里没有任何分析代码,也没有任何属于我们的端点。

它只往三类地方发请求:

1. **你配的模型 provider** —— 用你自己的 key。
2. **GitHub** —— 后台跑,一天最多一次,只为看看有没有新版本。**它只说,不装**;
   `alfa upgrade` 也从那儿下载。
3. **网页,而且只在你允许时** —— `webfetch` 和 `websearch` 每次都要批准,而且
   **刻意不给白名单**:风险不在于是哪个站点,而在于**是谁挑的它**。

其余一切 —— 会话、历史、存下来的工具输出、凭据 —— 都留在你机器上的
`~/.local/share/alfa/`。`/reset` 和 `alfa uninstall` 在删之前会把清单给你看。

## 从源码构建

```bash
git clone https://github.com/alfa-plus-laboratory/alfa
cd alfa
bun install
bun run typecheck && bun test
bun run build          # → bin/alfa-bin
```

需要 **[Bun](https://bun.sh) ≥ 1.3**,**不是 node**。发布的二进制用的是钉死的 bun
版本,因为 `bun build --compile` 会把运行时一起打进去:**用哪个版本构建,用户跑的
就是哪个**。

## 文档

[**DESIGN.md**](DESIGN.md) 是设计日志 —— 每一条判据、试过什么不行、删掉会怎样。
它很长,是中文的,而且是「这段代码当初为什么这么写」的唯一真值源。改东西之前读它,
用它之前不必。

[**AGENTS.md**](AGENTS.md) 是在这个仓库里干活的房规,很短,包括那几条**和通常默认
相反**的。

## 许可

[Apache-2.0](LICENSE)。上游致谢见 [NOTICE](NOTICE) —— 编译出来的二进制会把上游的
版权行全部剥掉,所以 NOTICE 是这些署名义务唯一的兑现渠道,它跟着每一次 release 一起发。
