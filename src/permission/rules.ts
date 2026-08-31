/**
 * 权限规则:HARD_DENY(表 A)+ DEFAULTS(表 B)。
 *
 * ── 两层的区别 ──
 * DEFAULTS 参与 last-wins 叠加,用户配置和 always 都能覆盖。
 * HARD_DENY **不参与**叠加,在 evaluate 之前单独跑一遍前置检查 —— 这是它
 * 「不给绕」的唯一实现方式。放进同一个数组然后指望它排最前是错的,后面的
 * 规则会盖掉它。
 *
 * ── 诚实的边界声明 ──
 * 这套东西挡的是**误操作**和**不老练的注入**。它挡不住一个刻意规避的模型:
 * `cat ~/.s''sh/id_rsa`、base64 编码、写个脚本再执行 —— 命令字符串匹配天生
 * 可绕。真正的边界是沙盒,而本地开发机上没有。所以:
 *   1. 不要因为有了门卫就放松别处;
 *   2. 子进程 env 白名单(src/env/whitelist.ts)和这套是互补的,那条路径
 *      门卫完全管不到。
 */
import { match } from "./wildcard.ts"

export type Action = "allow" | "ask" | "deny"

export interface Rule {
  permission: string
  pattern: string
  action: Action
}

export type Ruleset = Rule[]

// ════════════════════════════════════════════════ 表 A · HARD_DENY

export interface HardDenyRule {
  id: string
  /** 这条规则管哪些 permission。"*" 表示全部。 */
  permissions: string[]
  test(pattern: string): boolean
  reason: string
}

/**
 * 私钥与云凭据的路径特征。
 *
 * ★ 最后那两条是 **alfa 自己的**,而且拦的是**整个目录**不是 auth.json 一个文件。
 *   漏掉它们一度是这张表最尴尬的洞:内置 skill 会把 auth.json 的路径和 JSON 结构
 *   原样交给模型(它得能讲清配置放在哪),于是唯一拦着「cat 一下它」的东西是同一份
 *   skill 里的一句「不要读」—— 拿 prompt 里的一句话去防 prompt 注入,那不叫防御。
 *
 *   写成目录是因为按文件名拦会被 `grep -r . ~/.local/share/alfa/` 整个绕过。
 *   同一个目录里还躺着 sessions.db(每一次 read 的文件内容都在里面)。
 */
const CREDENTIAL_PATH =
  /(^|\/)(\.ssh\/id_(?!.*\.pub$)[^/]*|\.gnupg\/|\.aws\/credentials|\.config\/gcloud\/|\.kube\/config|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.local\/share\/alfa\/|\.config\/alfa\/)/

/** 出网 / 编码工具 —— 与凭据路径同现即视为外泄链路。 */
const EXFIL_TOOL = /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|base64|xxd|openssl\s+enc)\b/

export const HARD_DENY: HardDenyRule[] = [
  {
    id: "rm-root",
    permissions: ["bash"],
    // rm 带 -r 且目标是 / 、/* 、~ 、$HOME
    test: (c) => /\brm\b[^\n]*\s-[a-z]*r[a-z]*\b[^\n]*\s(\/|\/\*|~|\$HOME|\$\{HOME\})(\s|$)/.test(c),
    reason: "递归删除根目录或用户主目录",
  },
  {
    id: "mkfs",
    permissions: ["bash"],
    test: (c) => /\bmkfs(\.\w+)?\b/.test(c),
    reason: "格式化文件系统",
  },
  {
    id: "dd-device",
    permissions: ["bash"],
    test: (c) => /\bdd\b[^\n]*\bof=\/dev\//.test(c),
    reason: "向块设备直接写入",
  },
  {
    id: "device-write",
    permissions: ["bash"],
    test: (c) => /(>|>>)\s*\/dev\/(sd|nvme|hd|disk)/.test(c) || /\bshred\b[^\n]*\/dev\//.test(c),
    reason: "覆写块设备",
  },
  {
    id: "fork-bomb",
    permissions: ["bash"],
    test: (c) => /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(c.replaceAll(/\s+/g, " ")),
    reason: "fork bomb",
  },
  {
    id: "power",
    permissions: ["bash"],
    test: (c) => /^\s*(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/.test(c) || /^\s*(sudo\s+)?init\s+[06]\b/.test(c),
    reason: "关机或重启主机",
  },
  {
    id: "credential-read",
    permissions: ["read", "edit", "write", "grep", "glob"],
    test: (p) => CREDENTIAL_PATH.test(p.replaceAll("\\", "/")),
    // 工作区外的路径已经被越界守卫拦了;这条守的是「工作区本身就是 dotfiles 仓库」的情况
    reason: "读取私钥或云凭据文件",
  },
  {
    id: "credential-exfil",
    permissions: ["bash"],
    test: (c) => {
      const normalized = c.replaceAll("\\", "/")
      return CREDENTIAL_PATH.test(normalized) && EXFIL_TOOL.test(normalized)
    },
    reason: "同一条命令里同时出现凭据路径与出网/编码工具(数据外泄链路)",
  },
  {
    id: "link-local-fetch",
    permissions: ["webfetch", "bash"],
    // 169.254.0.0/16 与 IPv6 的 fe80::/10。云上的实例元数据端点
    // (169.254.169.254)一个不带认证的 GET 就吐临时凭据,是 SSRF 最经典的落点
    //
    // ★ 第三个分支是 **IPv4-mapped IPv6**:`http://[::ffff:169.254.169.254]/` 经
    //   WHATWG 的 URL 解析器会被归一化成 `[::ffff:a9fe:a9fe]` —— 十六进制,点分
    //   十进制那两条一条都不匹配。169.254 的十六进制是 a9fe,所以直接认它。
    //   同样的写法也能到 `[::ffff:7f00:1]`(127.0.0.1),见 web/url.ts 那边的对应修法。
    test: (p) =>
      /(^|\/\/|@|\s)(169\.254\.\d{1,3}\.\d{1,3}|\[?fe[89ab][0-9a-f]:)/i.test(p) ||
      /::ffff:(a9fe|7f[0-9a-f]{2}|c0a8|ac1[0-9a-f]|0?a[0-9a-f]{2}):/i.test(p),
    reason: "访问链路本地地址(云实例元数据端点,未认证即可取到临时凭据)",
  },
  {
    id: "credential-cat",
    permissions: ["bash"],
    // 读法不止 cat 一种 —— grep/rg 能把内容打出来,cp/tar 能把它搬到别处
    test: (c) =>
      /\b(cat|less|more|head|tail|strings|xxd|od|grep|rg|egrep|fgrep|awk|sed|cut|jq|base64|cp|mv|tar|zip)\b/.test(c) &&
      CREDENTIAL_PATH.test(c.replaceAll("\\", "/")),
    reason: "读取私钥或云凭据文件",
  },
]

export interface HardDenyHit {
  rule: HardDenyRule
  pattern: string
}

export function matchesHardDeny(permission: string, patterns: string[]): HardDenyHit | undefined {
  for (const rule of HARD_DENY) {
    if (!rule.permissions.includes(permission) && !rule.permissions.includes("*")) continue
    for (const pattern of patterns) {
      if (rule.test(pattern)) return { rule, pattern }
    }
  }
  return undefined
}

// ════════════════════════════════════════════════ 表 B · DEFAULTS

/**
 * 无副作用、不放行就会在第一分钟造成审批疲劳的只读命令。
 *
 * ⚠ 进这张表的判据是「**这个名字**的命令没有副作用」,而不是「常见用法没有副作用」。
 *   两条曾经在这里、现在被拿掉了,原因是它们过不了这条判据:
 *
 *     awk    —— 它是一门语言。`awk 'BEGIN{system("…")}'` 是它的正常写法,不是绕过。
 *     sed -n —— GNU sed 的 `e` 命令和 `s///e` 标志**真的执行**(验过),`w` 真的写文件。
 *              `-n` 只关掉自动打印,拦不住这两个。
 *
 *   还有几个名字留在表里,但带某个开关就会起别的程序(find -exec、rg --pre、
 *   sort --compress-program …)。那几个不能靠删名字解决 —— 不带那些开关时它们
 *   确实是天天要用的只读命令。它们由 scan() 的 EXEC_FLAGS 挡:命中就 forceAsk,
 *   绕过这里的 allow。**判据在两处,是因为一处是名字、一处是参数。**
 */
const READONLY_BASH = [
  "ls *", "pwd *", "cat *", "head *", "tail *", "wc *", "file *", "stat *", "which *", "echo *",
  "date *", "env *", "printenv *", "whoami *", "hostname *", "uname *", "df *", "du *", "tree *",
  "grep *", "rg *", "find *", "sort *", "uniq *", "diff *", "cmp *", "basename *", "dirname *",
  "git status *", "git diff *", "git log *", "git show *", "git branch *", "git remote *",
  "git rev-parse *", "git blame *", "git describe *", "git ls-files *", "git stash list *",
]

/**
 * 项目自己的活儿:构建、测试、检查、格式化。
 *
 * ── 为什么这张表必须存在 ──
 * 把 bash 收成「默认 ask」造出了一个巨大的灰色档,而灰色档一大,就只能塞给
 * 判官 —— 于是一个会紧张、每次几百毫秒、答案还不稳定的东西站在了每天要走
 * 几十次的路上。**判官该是兜底,不是灰色档的默认处理者。**
 *
 * 这一档的爆炸半径就是这个项目本身,而且它跑的是项目自己声明的命令(package.json
 * 的 script、Makefile 的 target)。opencode 干脆整个 `"*": "allow"`,Claude Code
 * 靠一张宽白名单 + 规则落盘 —— 两家的「丝滑」都来自**根本不问**,不是来自
 * 问得更聪明。
 *
 * 注意这张表压不过 scan.ts 的 force:命令里出现子 shell、重定向、提权、出网,
 * 照样要问 —— 危险不在命令名里,在它周围的结构里。
 */
const PROJECT_BASH = [
  "npm test *", "npm run *", "pnpm test *", "pnpm run *", "yarn test *", "yarn run *",
  "bun test *", "bun run *", "bunx tsc *",
  "pytest *", "python -m pytest *", "python3 -m pytest *", "tox *", "nox *",
  "make *",
  "cargo test *", "cargo build *", "cargo check *", "cargo clippy *", "cargo fmt *", "cargo bench *",
  "go test *", "go build *", "go vet *", "go fmt *", "gofmt *",
  "tsc *", "eslint *", "prettier *", "biome *",
  "ruff *", "black *", "isort *", "mypy *", "flake8 *", "pylint *",
  "jest *", "vitest *", "mocha *", "phpunit *", "rspec *",
]

/**
 * 上面那张表里会伸出项目之外的那几个。last-wins,所以写在后面。
 *
 * `npm run test` 和 `npm run deploy` 共用一个前缀,但一个是在自己机器上跑测试,
 * 另一个是把东西推到世界上去 —— 后者正是「后果重,所以该由人点头」的典型。
 */
const PROJECT_BASH_EXCEPTIONS = [
  "npm run *deploy*", "npm run *publish*", "npm run *release*", "npm run *push*",
  "pnpm run *deploy*", "pnpm run *publish*", "pnpm run *release*",
  "yarn run *deploy*", "yarn run *publish*", "yarn run *release*",
  "bun run *deploy*", "bun run *publish*", "bun run *release*",
  "make deploy*", "make publish*", "make release*", "make install*", "make uninstall*",
  "cargo publish*", "go install*",
]

/**
 * 默认规则表。顺序即优先级(后面的覆盖前面的)。
 *
 * 与 opencode 的主要分歧:
 *   - 他们 `"*": "allow"` 全放开,我们对 bash 收成 ask + 白名单(只读 + 项目自身);
 *   - read 的敏感文件名清单他们只写了 *.env / *.env.*,漏了 .envrc / *.pem / *.key。
 *   - edit 我们跟他们一样 allow —— 但**每次强制打 diff**,不给静默改错留窗口。
 */
export const DEFAULTS: Ruleset = [
  // 兜底:不放这条的话,以后每加一个新工具都会开始弹窗
  { permission: "*", pattern: "*", action: "allow" },

  // ── read:默认放行,工作区内的密钥文件要问 ──
  //
  // ⚠ 每条都必须以 * 开头。pattern 是拿**整条相对路径**去匹配的,
  //   写 ".envrc" 只能命中仓库根那一个,子目录里的 "config/.envrc" 会漏。
  //   这类漏规则不报错,只是永远不命中 —— 静默失效。
  { permission: "read", pattern: "*", action: "allow" },
  ...[
    "*.env", "*.env.*", "*.envrc", "*secret*", "*credential*",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.jks",
    "*id_rsa*", "*id_ed25519*", "*id_ecdsa*", "*id_dsa*",
  ].map((pattern): Rule => ({ permission: "read", pattern, action: "ask" })),
  // 模板文件里没有真值,拦它纯属骚扰
  ...["*.env.example", "*.env.sample", "*.env.template", "*.pem.example"].map(
    (pattern): Rule => ({ permission: "read", pattern, action: "allow" }),
  ),

  // ── edit / write:默认放行(用户决定),但 diff 恒可见 ──
  { permission: "edit", pattern: "*", action: "allow" },
  // 改 CI 配置 = 改一台会自动执行的机器
  { permission: "edit", pattern: "*.github/workflows/*", action: "ask" },
  { permission: "edit", pattern: "*.git/*", action: "ask" },
  ...["*.env", "*.env.*", "*.envrc", "*.pem", "*.key", "*id_rsa*", "*id_ed25519*"].map(
    (pattern): Rule => ({ permission: "edit", pattern, action: "ask" }),
  ),

  // ── bash:默认问,只读命令 + 项目自己的活儿放行 ──
  { permission: "bash", pattern: "*", action: "ask" },
  ...READONLY_BASH.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })),
  ...PROJECT_BASH.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })),
  // last-wins:上面放行了整类,这里把其中会伸出项目之外的那几个再拉回来问。
  // 「发布」和「跑测试」共用一个 npm run 前缀,但它们完全不是一回事
  ...PROJECT_BASH_EXCEPTIONS.map((pattern): Rule => ({ permission: "bash", pattern, action: "ask" })),

  // ── 检索:放行 ──
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },

  // ── 计划:放行 ──
  // 它只往界面上写一份清单,盘上和网上什么都不碰。列在这里不是为了「允许」
  // (兜底那条已经允许了),是为了让「把它关掉」这件事有个明确的地方可写
  { permission: "todo", pattern: "*", action: "allow" },

  // ── 项目记忆:放行 ──
  // 它只在工作区里那一个目录下写小文件,名字过了规范化,走不出去。列在这里
  // 和 todo 同理 —— 想把「它自己记东西」整个关掉的人,得有个地方写得下
  { permission: "memory", pattern: "*", action: "allow" },

  // ── 看一眼自己的上下文:放行 ──
  // 只读一个进程内的数字。列在这里同理 —— 关得掉才算一个选项
  { permission: "context", pattern: "*", action: "allow" },

  // ── 停下来问你一句:放行 ──
  // 它什么都不碰,只是等人。列在这里是因为「我不想被打断,你自己决定」是一条
  // 完全正当的规则,而它得有个地方写得下(写 deny 之后这个工具连发都不发给
  // 模型 —— 见 gate.disabled)
  { permission: "ask", pattern: "*", action: "allow" },

  // ── 派一个子 agent 出去:放行 ──
  // 它自己每一步照旧过这张表(同一个门卫、同一份"以后不再问"),所以这里问的
  // 是另一件事:要不要让它自己派活儿。想要一个"只用你自己那条命"的 agent 的人,
  // 在这里写 deny
  { permission: "task", pattern: "*", action: "allow" },

  // ── 横切守卫 ──
  { permission: "external_directory", pattern: "*", action: "deny" },

  // ── 出网:问 ──
  //
  // 这两条是**故意**没有白名单的。别处的 ask 都配了一张放行表(只读命令、
  // 项目自己的活儿),这里没有,因为出网这件事的风险不在"去哪个站",在
  // **是谁决定去的**:URL 可能来自上一个页面、一条 issue、一份 README,
  // 而那些地方的字不是用户写的。让每一次第一趟出网在用户眼前过一遍,是
  // "注入进来的地址"和"用户想看的页面"之间唯一的区别。
  // 一个域名点过 always 之后就不再问了(见 gate.ts 的 narrowAlways)。
  { permission: "webfetch", pattern: "*", action: "ask" },
  { permission: "websearch", pattern: "*", action: "ask" },

  // ── MCP:问 ──
  //
  // 目标写成 `server/tool`,所以 always 可以点单个工具,也可以写成 `github/*`
  // —— 用户心里的单位是"这个 server",不是"这个函数"。
  //
  // 这一条同样**故意**没有白名单,而且理由比出网那两条更硬:一个 MCP 工具能干
  // 什么,只有写它的人知道。MCP 自己带的 readOnlyHint 之类的标注是 **server
  // 自报的**,拿它当放行依据等于让被审查的一方填审查结论。
  // (兜底本来就是 ask —— 见文件末尾的 evaluate。写在这里是为了让这张表能被读到:
  //  一条不在表上的规则,下一个人读完只会以为我们忘了。)
  { permission: "mcp", pattern: "*", action: "ask" },
]

// ════════════════════════════════════════════════ 求值

/**
 * 多个 ruleset 依次叠加,**最后一条匹配到的规则胜出**。
 *
 * 为什么是 last-wins 而不是 first-wins / most-specific-wins:
 * 用户配置写在后面就一定能覆盖内置默认,不需要理解「特异性」这种隐式概念。
 * 代价是同一个 ruleset 内部的书写顺序有意义 —— 通配的放前面,例外放后面。
 */
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Action {
  let result: Action | undefined
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (rule.permission !== permission && rule.permission !== "*") continue
      if (!match(rule.pattern, pattern)) continue
      result = rule.action
    }
  }
  return result ?? "ask" // 兜底:没有任何规则命中时保守处理
}

/**
 * 把配置里的 `{ bash: "ask", read: { "*": "allow", "*.env": "deny" } }`
 * 归一成有序 Ruleset。
 *
 * ⚠ 保序是硬需求。JS 对象的数字型 key 会被引擎提前,所以调用方必须先用
 *   Object.entries 拿到书写顺序,别在中间层再塞回对象。
 */
export function fromConfig(config: Record<string, Action | Record<string, Action>>): Ruleset {
  const rules: Ruleset = []
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value })
      continue
    }
    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ permission, pattern, action })
    }
  }
  return rules
}
