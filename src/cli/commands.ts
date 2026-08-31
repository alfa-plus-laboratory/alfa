/**
 * 斜杠命令表与补全。
 *
 * ── 为什么要有补全 ──
 * 命令做得再少,不写出来用户也不知道有。`/` 一敲就把能用的全列出来,比在
 * help 里藏一段强 —— 那段没人会去翻第二遍。
 *
 * ── 只认行首的斜杠 ──
 * `src/cli/main.ts` 里的 `/` 是路径不是命令。所以补全只在**整段输入以 `/` 开头**
 * 且光标在末尾时才出现。判宽一点的代价是用户打路径时冒出个框挡住视线,
 * 那比少一个补全烦人得多。
 *
 * ── `@` 是另一回事:它在哪儿都算 ──
 * 斜杠命令必须独占一整行(它是命令,不是内容),而 `@src/foo.ts` 是一句话
 * **中间**的一个词。所以它按「光标所在的那个词」判,不看行首,也不管有没有
 * 换行。文件从哪来不归这里管 —— 调用方给一个查询函数(见 cli/mentions.ts),
 * 这个模块照旧不认识文件系统。
 *
 * ── 纯函数 ──
 * 这里不认识终端、不认识 App。给一段文本和光标位置,返回该补什么。
 * 但**说明文字要现取**(commands() 是函数不是常量):界面语言能在运行时改,
 * 一张在 import 时就定死的表切完语言还是旧的。
 *
 * ── 参数可以有下一级 ──
 * `/language interface zh` 是两级。所以候选是棵树,不是一层列表 ——
 * 走到哪一级就列哪一级的候选。
 */
import { t } from "../i18n/index.ts"
import { LANGUAGE_CHOICES } from "../i18n/index.ts"
import { MODES } from "../permission/mode.ts"
import { VIEW_MODES } from "../config/config.ts"

export interface CommandArg {
  value: string
  hint: string
  /** 这一级选完之后还有下一级 */
  args?: CommandArg[]
}

/**
 * 「什么都不加」在候选里长什么样。
 *
 * 它是一条**值为空**的候选:选中它,输入框里那一段不变,而回车就此放行 ——
 * 因为「打的字」和「高亮那条的值」这时候都是空的,补全自己就判成"已经打全了"
 * (见 tui/panes/complete.ts 的 exact)。所以它不是特例分支,是既有规则的一个用法。
 *
 * 画出来要有个东西占位,否则那一行是空白的。`↵` 正好说的就是该按什么。
 */
export const BARE_LABEL = "↵"

export interface SlashCommand {
  /** 带斜杠的全名 */
  name: string
  hint: string
  /** 参数候选。有它才会在敲完空格之后继续提示 */
  args?: CommandArg[]
  /** 别名照常能用,但不出现在候选列表里 —— 列表越短越有用 */
  aliases?: string[]
  /**
   * 不带参数时它做什么。**有这一句就等于说「这条命令自己就是一条完整的命令」**,
   * 于是「什么都不加」会作为第一条候选出现(见 BARE_LABEL)。
   *
   * ── 为什么必须有这条候选 ──
   * 补全在补完命令名之后会顺手补一个空格(后面还有一级嘛),紧接着弹出参数候选,
   * 而回车此时选中的是**第一条参数**。于是 `/upgrade` 这种「不加参数才是最常用
   * 用法」的命令,唯一按不出来的恰恰是那个最常用的用法 —— 用户得先按退格再回车。
   * 一个把默认动作藏起来、还要你多按一次键才能用的补全,是在帮倒忙。
   */
  bareHint?: string
}

/**
 * `/model` 的候选。
 *
 * 由宿主在装配时灌进来(见 cli/main.ts),因为这张表要问注册表 —— 而这个模块
 * 不认识 provider,也不该认识。和 i18n 的 setInterfaceLanguage 同一条路子:
 * 一个纯函数模块 + 一份运行时注册的数据,比给 complete() 再加一个参数层层往下
 * 传要轻,而这份数据一场里只灌一次。
 *
 * 灌不进来(没配过候选)完全正常:`/model` 照旧能用,自由输入任何
 * provider/model —— 少的只是按 tab 弹出来的那张单子。
 */
let modelChoices: string[] = []

export function setModelChoices(specs: string[]): void {
  modelChoices = specs
}

/** 语言候选。interface 和 reply 的 auto 含义不同,所以说明分开写。 */
function languageArgs(kind: "interface" | "reply"): CommandArg[] {
  return LANGUAGE_CHOICES.map((choice) => ({
    value: choice,
    hint:
      choice === "auto"
        ? kind === "interface"
          ? t.languageAutoInterfaceHint
          : t.languageAutoReplyHint
        : choice === "en"
          ? t.languageEnglish
          : choice === "zh"
            ? t.languageChinese
            : t.languageJapanese,
  }))
}

export function commands(): SlashCommand[] {
  return [
    {
      name: "/permission",
      hint: t.cmdPermission,
      bareHint: t.bareCurrent,
      args: [
        ...MODES.map((mode) => ({
          value: mode,
          hint: mode === "confirm" ? t.modeConfirmHint : mode === "default" ? t.modeDefaultHint : t.modeTrustHint,
        })),
        // 和三个模式排在一起,因为它回答的是同一个问题(「工具调用怎么批准」),
        // 而且看得见才撤得掉 —— 一条存下来却找不到入口的放行规则等于没得撤
        { value: "forget", hint: t.modeForgetHint },
      ],
    },
    {
      name: "/view",
      hint: t.cmdView,
      bareHint: t.bareCurrent,
      args: VIEW_MODES.map((view) => ({
        value: view,
        hint: view === "session" ? t.viewSessionHint : t.viewStreamHint,
      })),
    },
    {
      name: "/language",
      hint: t.cmdLanguage,
      bareHint: t.bareCurrent,
      args: [
        { value: "interface", hint: t.languageInterfaceHint, args: languageArgs("interface") },
        { value: "reply", hint: t.languageReplyHint, args: languageArgs("reply") },
      ],
    },
    {
      name: "/think",
      hint: t.cmdThink,
      bareHint: t.bareToggle,
      // 不带参数就是切换。列出 on/off 是给「我想确定它现在是开还是关」的人用的 ——
      // 一个只能靠切一下看结果的开关,用户永远不确定自己按对了没有
      args: [
        { value: "on", hint: t.thinkingHint },
        { value: "off", hint: t.thinkingOff },
      ],
    },
    {
      name: "/agentflow",
      hint: t.cmdAgentflow,
      bareHint: t.bareToggle,
      // 只列 on/off。那个数字(同时几个)照旧打得出来,但把 2-12 全列成候选,
      // 会让一条二值开关看上去像一道要先想清楚的题
      args: [
        { value: "on", hint: t.agentflowHint },
        { value: "off", hint: t.agentflowOffHint },
      ],
    },
    {
      name: "/model",
      hint: t.cmdModel,
      bareHint: t.bareCurrent,
      // `/models` 是别名,和 `/context`+`/content` 同一条理由:这条命令**同时**
      // 是"列出模型"和"换一个模型",两种说法都自然,不值得为其中一种出一次
      // 「未知命令」。列表里只列一个
      aliases: ["/models"],
      // 一条也没有时**不给 args**:给一个空数组的话,敲完 "/model " 会弹一个
      // 空框出来,而那看起来像"没有能选的模型",实际是"没人配过候选"
      ...(modelChoices.length > 0
        ? { args: modelChoices.map((spec) => ({ value: spec, hint: "" })) }
        : {}),
    },
    // 排在这一撮"改设置"的最前面。它是别的几条的**总目录** —— 记不住
    // `/agentflow` 叫什么的人,记得住这一条
    {
      name: "/setting",
      hint: t.cmdSetting,
      // 三个名字都认。这条命令没有一个所有人都会先想到的叫法,而为了猜错
      // 一个字母出一次「未知命令」,是拿用户的时间换我们少写两行
      aliases: ["/settings", "/config"],
    },
    { name: "/resume", hint: t.cmdResume },
    { name: "/summary", hint: t.cmdSummary },
    // `/content` 是别名:窗口里装的东西叫 context,但手指打成 content 的概率
    // 高到不值得为它出一次「未知命令」—— 两个都认,列表里只列一个
    { name: "/context", hint: t.cmdContext, aliases: ["/content"] },
    // 参数是**自由文本**(这次要特别保住什么),所以候选里只有 `auto` 那一支
    // 和「什么都不加」。没有 bareHint 的话,补完命令名之后回车选中的是 auto ——
    // 而这条命令最常用的用法恰恰是什么都不加
    {
      name: "/compact",
      hint: t.cmdCompact,
      bareHint: t.bareCompactNow,
      args: [{ value: "auto", hint: t.autoCompactHint }],
    },
    {
      name: "/check",
      hint: t.cmdCheck,
      bareHint: t.bareRunNow,
      // 不带参数 = 立刻跑一次。on/off 列出来的理由和 /think 一样:一个只能靠
      // 切一下看结果的开关,用户永远不确定自己按对了没有
      args: [
        { value: "on", hint: t.checkOnHint },
        { value: "off", hint: t.checkOffHint },
      ],
    },
    // 排在检查后面、帮助前面:它和 /check 一样是「对这个项目做点什么」,
    // 而不是「对这一场会话做点什么」
    { name: "/init", hint: t.cmdInit },
    { name: "/mcp", hint: t.cmdMcp },
    // 紧挨着 /mcp:两条讲的是同一件事的两半 —— 这个仓库能对模型说什么、
    // 能让我们起什么进程
    {
      name: "/trust",
      hint: t.cmdTrust,
      bareHint: t.trustShowHint,
      args: [
        { value: "on", hint: t.trustOnHint },
        { value: "off", hint: t.trustOffHint },
        { value: "check", hint: t.trustCheckHint },
      ],
    },
    { name: "/skills", hint: t.cmdSkills },
    // 和 `alfa upgrade` 是同一件事。之所以在会话里也要有一个入口:启动横幅
    // 上那句「有新版了」正是用户看见它的时刻,而那时候他手里只有这个窗口 ——
    // 让他为了升个级去另开一个终端,多数人当场就把这件事放下了
    {
      name: "/upgrade",
      hint: t.cmdUpgrade,
      // 不带参数就是这条命令本身该做的事,所以借它自己那句说明
      bareHint: t.cmdUpgrade,
      // 只列 force。`check` 照收(手指有记忆),但它和不带参数是同一件事 ——
      // 两条一模一样的候选摆在一起,读的人只会停下来想它们差在哪
      args: [{ value: "force", hint: t.upgradeForceHint }],
    },
    // 和 /resume 是一对(那条列历史,这条删历史),但排在这一小撮删东西的里面。
    // ★ 天数给候选,`confirm` **不给** —— 和 /reset 同一条:确认必须一个字一个字
    //   地打全,一个 tab 一下就能补出来的确认等于没有确认
    {
      name: "/history-clean",
      hint: t.cmdCleanHistory,
      // 旧名字照收,但不列出来。它一度叫 /clean-history,而那个名字和 /clear
      // 撞前缀:敲 `/cl` 弹出来的是两条,其中一条是"删掉大半年的历史"、另一条是
      // "开一场新对话"—— 两条在这个列表里挨着,而它们的后果差着一个数量级
      aliases: ["/clean-history"],
      bareHint: t.bareListFirst,
      args: [
        { value: "7", hint: t.cleanDaysWeek },
        { value: "30", hint: t.cleanDaysMonth },
        { value: "90", hint: t.cleanDaysQuarter },
      ],
    },
    // 排在最后那一小撮里,而且**不给参数候选**:`confirm` / `all` 不该被 tab
    // 补出来。这条命令唯一的安全边界就是"必须一个字一个字地打全"
    { name: "/reset", hint: t.cmdReset },
    { name: "/help", hint: t.cmdHelp },
    { name: "/clear", hint: t.cmdClear },
    { name: "/exit", hint: t.cmdExit, aliases: ["/quit"] },
  ]
}

export interface CompletionItem {
  /** 选中之后填进输入框的那一段 */
  value: string
  /**
   * 画出来的样子。不给就画 value —— 只有「什么都不加」那条需要它,
   * 因为它的 value 是空的,不给个占位符那一行就是一片空白
   */
  label?: string
  hint: string
  /**
   * 补完之后顺手带个空格。
   *
   * 命令是「后面还有一级参数」,`@` 引用是「这条已经完整了,接着写下一句」——
   * 两种情况下用户要打的下一个字都不是空格,所以是同一个标志。
   */
  more?: boolean
}

export interface Completion {
  items: CompletionItem[]
  /** 补全要替换掉 text 的 [from, to) */
  from: number
  to: number
  /** 补完之后是不是还要接着输入(命令有参数时补完补一个空格) */
  trailingSpace: boolean
}

/** 查文件候选。由 cli/mentions.ts 那个索引实现 —— 这里只认这个签名。 */
export type FileSource = (query: string) => CompletionItem[]

/**
 * 光标处该补什么。没得补返回 undefined。
 *
 * 只在光标位于末尾时给候选:补全的位置感全靠「你正在打的就是最后那个词」,
 * 光标跑回中间还弹框的话,选中之后内容会插到一个用户没预期的地方。
 */
export function complete(text: string, cursor: number, files?: FileSource): Completion | undefined {
  if (cursor !== text.length) return undefined

  // `@` 先判:它可以出现在任何位置,包括一条斜杠命令的参数里
  const mention = mentionAt(text, cursor)
  if (mention !== undefined && files) {
    const items = files(mention.query)
    if (items.length === 0) return undefined
    return { items, from: mention.from, to: cursor, trailingSpace: false }
  }

  if (!text.startsWith("/")) return undefined
  // 多行输入里的 / 不算命令 —— 命令永远是单独一行
  if (text.includes("\n")) return undefined

  const tokens = text.split(" ")
  const typed = tokens[tokens.length - 1] ?? ""
  const from = text.length - typed.length

  // ── 还在打命令名 ──
  if (tokens.length === 1) {
    const prefix = typed.toLowerCase()
    const items = commands()
      .filter((command) => command.name.startsWith(prefix))
      .map((command) => ({ value: command.name, hint: command.hint, ...(command.args ? { more: true } : {}) }))
    if (items.length === 0) return undefined
    const only = items.length === 1 && items[0]!.value === text
    // 已经打全了、而且它没有参数:框留着只会挡视线
    if (only && !lookup(text)?.args) return undefined
    return { items, from: 0, to: text.length, trailingSpace: false }
  }

  // ── 在打参数:先按已经打完的那几段往下走 ──
  const command = lookup(tokens[0] ?? "")
  let level = command?.args
  for (const token of tokens.slice(1, -1)) {
    if (!level) return undefined
    level = level.find((arg) => arg.value === token.toLowerCase())?.args
  }
  if (!level) return undefined

  const prefix = typed.toLowerCase()
  const items: CompletionItem[] = level
    // 大小写不敏感:别的候选本来就全是小写,而模型名不一定 —— 不少端点的
    // 模型名带大写,照原样比的话,打小写一个都匹配不上
    .filter((arg) => arg.value.toLowerCase().startsWith(prefix))
    .map((arg) => ({ value: arg.value, hint: arg.hint, ...(arg.args ? { more: true } : {}) }))

  // ★ 「什么都不加」排第一,而且只在**第一级、还一个字都没打**的时候给:
  //   打了字就说明用户要的是某个参数(空值也匹配不上任何前缀),而第二级的
  //   「什么都不加」多半不是一条完整命令(`/language interface` 就不是)
  if (tokens.length === 2 && prefix.length === 0 && command?.bareHint) {
    items.unshift({ value: "", label: BARE_LABEL, hint: command.bareHint })
  }
  if (items.length === 0) return undefined
  return { items, from, to: text.length, trailingSpace: false }
}

/**
 * 光标所在的那个词是不是一个 `@` 引用。
 *
 * 往回扫到第一个空白为止 —— 词的边界就是空白,不是标点。`@src/a-b.ts` 里的
 * 连字符和点都是路径的一部分,按标点断词的话,打到一半就再也补不出来了。
 */
function mentionAt(text: string, cursor: number): { from: number; query: string } | undefined {
  let at = cursor
  while (at > 0 && !/\s/.test(text[at - 1] ?? "")) at--
  const token = text.slice(at, cursor)
  if (!token.startsWith("@")) return undefined
  return { from: at, query: token.slice(1) }
}

/** 按全名或别名找命令。 */
export function lookup(name: string): SlashCommand | undefined {
  const key = name.toLowerCase()
  return commands().find((command) => command.name === key || command.aliases?.includes(key))
}

/** 把选中的候选填回输入框,返回新文本(光标落在末尾)。 */
export function apply(text: string, completion: Completion, item: CompletionItem): string {
  const head = text.slice(0, completion.from)
  const tail = text.slice(completion.to)
  // 后面还有一级就顺手补个空格,少按一次
  const suffix = item.more ? " " : ""
  return head + item.value + suffix + tail
}
