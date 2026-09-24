# alfa

终端里的本地优先 coding agent。接上自己的 API 和模型，读对话、看改动、继续输入。

[English](README.md) · [日本語](README.ja.md)

```text
› 修复配置解析
  · read src/config.ts
  edit src/config.ts +2 -1
  - oldValue
  + newValue
  测试通过，现在保留空值。
›
```

## 安装与开始

一条命令安装最新版，无需先安装 Bun。

**macOS / Linux：**

```sh
curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
```

**Windows（PowerShell）：**

```powershell
irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
```

安装脚本自动选择平台并校验 SHA-256。macOS/Linux 默认安装到 `~/.local/bin`，Windows 默认安装到 `%LOCALAPPDATA%\Programs\alfa`。若安装目录不在 `PATH` 中，按脚本打印的命令添加；脚本不会自动修改 shell 配置或环境变量。随后运行 `alfa` 配置模型。

也可以在 [Releases](https://github.com/alfa-plus-laboratory/alfa/releases/latest) 手动下载二进制及校验文件。

**升级：**

```sh
alfa upgrade
```

**卸载：**先查看将删除的内容：

```sh
alfa uninstall
```

确认后，一条命令执行卸载：

```sh
alfa uninstall confirm
```

卸载会删除已安装的程序、全局配置、保存的凭据、会话数据，以及当前目录下存在的 `.alfa/`。其他项目的 `.alfa/` 和 `PATH` 设置保留。Windows 若提示可执行文件已改名，退出后按打印的清理命令删除残留文件。

Shell 文件隔离使用 macOS Seatbelt 或 Linux bubblewrap（通过系统包管理器安装 `bwrap`）。缺少支持的后端时拒绝运行 shell，文件工具仍可使用。Windows 可在装有 bubblewrap 的 WSL 中运行。

```sh
alfa
alfa -m gateway/model-id -p "说明这个项目"
alfa --continue
alfa --resume
printf '解释失败的测试\n' | alfa
```

配置使用五步向导：厂商 → 连接 → 凭据 → 模型 → 检查并连接。↑↓ 选择、Enter 确认，输入可搜索；模板预填端点和协议，高级鉴权设置按需展开，测试失败可返回修改草稿。日常对话保持单列简洁。

首次启动直接引导：厂商模板或自定义 API → 协议 → 端点 → 隐藏输入凭据 → 发现模型或手输 ID → 真实请求测试 → 立即切换或设为默认。测试失败或取消不保存半份配置。

`/setting` 的模型/厂商/凭据入口可添加（搜索框输入 `+`）、搜索、编辑、启用、禁用、删除厂商与模型记录、测试连接、切换模型。`/model provider/model` 保留，并在没有 `ALFA_MODEL` 覆盖时记住默认模型。不支持 `/models`、网络出错或列表不完整都不表示“没有模型”；始终支持手输 ID。回环本地端点可选择无密钥认证。

具名厂商共用三种协议适配器：`anthropic`、`openai-responses`（OpenAI-compatible Responses API）、`openai-chat`（OpenAI-compatible Chat Completions）。新的自定义端点默认走 Responses；不支持 `/responses` 的旧网关需显式选择 Chat Completions。模板只是预填值；支持自定义鉴权头和关闭模型发现。

普通设置在 `config.json`，凭据单独存在权限为 0600 的 `auth.json`。环境变量优先：`ALFA_MODEL`、`ALFA_KEY_<NAME>`、`ALFA_BASE_URL_<NAME>`，以及原有的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`、`OPENAI_API_KEY` / `OPENAI_BASE_URL`。设置里展示密钥和端点的生效来源。密钥隐藏或遮罩显示，没有完整显示密钥的命令。旧的 `alfa auth login/list/logout` 仍可使用。

## 对话与操作

只有一套单列时间线。回答、错误、审批、edit/write diff 留在终端原生滚动记录中；输入区只展示当前活动。`/detail` 找回最近一次完整工具记录，`/detail read` 或 `/detail <callID>` 按工具/调用查看。`/jobs`、`/agents` 查看后台任务。直接使用终端原生拖选与复制。

运行时，输入框上方一行显示它在做什么（思考、输出、哪个工具）、本回合用时和思考的尾巴；固定行显示计划进度、子代理（运行中或挂起——挂起的保留记忆、可再次唤醒；`kill` 则彻底移除）和后台进程。底栏显示上下文占用、实际缓存命中率和输出速度。

- Enter 发送；运行中可补充或排队。Ctrl-J / Alt-Enter 换行。
- Esc 中断。Ctrl-C 清空或中断，空输入连续两次退出；Ctrl-D 退出。
- 输入 `/` 显示命令候选；↑↓ 选择、Tab 补全、Enter 执行。Shift-Tab 切换权限模式。
- 用 `@shot.png`、把文件拖进终端，或 Ctrl-V 粘贴剪贴板截图来附加图片。Cmd-V 只能粘贴文字，复制的图片要用 Ctrl-V；粘贴的 `data:image/…` 链接（Google 图片“复制图片地址”得到的就是它）也会作为图片附加。
- `/setting` 同时覆盖权限、外部路径、项目信任、语言、检查、子代理并发、思考、推理强度和压缩。
- 保留 `/context`、`/compact`、`/check`、`/trust`、`/language`、`/think`、`/effort`、`/agentflow`、`/resume`、`/clear`、`/skills`、`/mcp`、`/init`、`/history-clean`、`/reset`。

`--plain`、`--no-mouse` 是兼容别名；`/view` 解释迁移。全屏面板、机器人、鼠标接管及布局设置已退役。旧 `view` / `panels` 配置被忽略，下次保存时移除。`-p` 和管道模式不会接管交互终端。

## 权限

alfa 默认自己干活（`auto`）。工作区里的读取和编辑直接执行；其余操作交给分类器判断：你要求得有多明确，对比可能造成的代价。你没要求过的高风险操作会退回给 alfa，让它换个办法，或者来问你。要碰工作区以外的目录时会先问你；授权过的目录用 `/access` 管理。

想自己把关，按 Shift-Tab 切到 `default`（工作区读写直接放行，其余要你确认）或 `confirm`（每一步都要你确认）。

这是判断，不是隔离：alfa 执行的命令拥有你这个账户的权限。Shell 命令的 OS 沙盒是实验功能，可以在 `/settings` 里打开。

## 扩展、评测与开发

保留 skills、MCP。外部 API v1 支持工具、调用前后事件、`/x:name` 命令及纯文本通知。全局配置必须显式指定审阅过的扩展绝对路径和入口 SHA-256；扩展拥有**宿主权限**。见 [扩展接口](docs/extensions.md) 和 [示例](examples/extension.ts)。

三项可重复编码任务覆盖 CSV 解析、跨包 API 迁移、重试取消。[评测说明](eval/README.md) 包含独立验收测试、耗时、token、价格、审批次数、中断恢复。夹具验证不是模型成功率，不宣称优于其它 agent。

源码需要 Bun ≥ 1.3：

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

模型请求直连所配厂商，web/MCP 工具可另行联网。会话存在本地 SQLite，工具输出和调试日志可能包含项目内容。没有 alfa 账号或遥测服务。

设计记录：[DESIGN.md](DESIGN.md)。参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)；安全问题报告：[SECURITY.md](SECURITY.md)；更新记录：[CHANGELOG.md](CHANGELOG.md)。许可：[Apache-2.0](LICENSE)；第三方声明：[NOTICE](NOTICE)。
