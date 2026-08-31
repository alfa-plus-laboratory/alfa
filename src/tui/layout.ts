/**
 * 界面骨架的尺寸计算。
 *
 * 整个界面是**一个**框:上面横着三栏,下面横跨全宽的输入框,最下面一行状态。
 * 这里只算坐标,不画东西 —— 画交给 chrome.ts,内容交给各个面板。
 *
 *   ╭─ files ────┬─ conversation ─────┬─ live.ts ────╮   rowTop
 *   │ ▾ src      │ ─[▮  ]─ ───────────│  218  …      │
 *   │   live.ts M│ ● edit live.ts     │ -220  …      │   bodyHeight 行
 *   │            ├────────────────────┤              │   inputRule
 *   │            │ /permission  switch│              │   completion(可选)
 *   │            │ › /pe              │              │   input
 *   ├────────────┴────────────────────┴──────────────┤   statusRule
 *   │ ~/code/x · anthropic/claude-sonnet-4-5 · auto · tab 换栏 │   statusRow
 *   ╰────────────────────────────────────────────────╯   rowBottom
 *
 * ── 输入长在中间栏里 ──
 * 它一度是横跨三栏的一整带。那一带里除了输入什么都没有,却把左右两栏各截短
 * 一截 —— 文件树和 diff 白白少几行。输入是「你对这段对话说的话」,和对话
 * 同宽、在对话正下方才是它该待的地方。
 *
 * ── 窄了先收哪一栏 ──
 * 对话是主体,任何时候都不能没有。收的顺序是:右栏 → 左栏 → 只剩对话。
 * 收掉不等于关掉:快捷键能把它临时叫回来盖在对话上,关掉就恢复原样。
 * 这样 80 列分屏、手机 SSH 都还能用,而不是甩一句 "terminal too narrow"。
 *
 * ── 收起来的栏留一条轨 ──
 * 自己按键/点按钮收掉的栏不会**整个消失**,原地留一条三列宽的竖轨,顶上画一个
 * `[+]`。收起来之后屏幕上什么都不剩的话,"它去哪了、怎么回来"就只能靠记忆或者
 * 翻帮助 —— 而收起来本来就是个随手的动作,复原也该是。
 * 窄屏**自动**折叠的那些不留轨:那时候正是没地方了,再占三列是反着来的。
 *
 * ── 中间栏是上下四块 ──
 * 对话 / 计划 / 工具看板 / 输入,自上而下,各自一条带标题的横线隔开。
 * 计划在看板**上面**:它讲的是「接下来还有什么」,看板讲的是「现在动的哪只手」,
 * 时间上前者在后者之前;而看板贴着输入框才好扫一眼。三块都属于**这段对话**,
 * 所以它们和对话同宽、排在同一栏里 —— 左栏留给「这个仓库里有什么」。
 *
 * ── 侧栏为什么不用百分比 ──
 * 文件树的内容宽度有下限(缩进 + 文件名 + git 标记),按百分比分的话一到窄屏
 * 就变成一列省略号。所以侧栏走「理想宽度 + 上下限」,多出来的全给对话 ——
 * 对话越宽越有用,树宽到 40 列没有任何意义。
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type PaneName = "tree" | "plan" | "chat" | "detail" | "input"
export type SideName = "tree" | "detail"
/**
 * 能被用户自己收起来的面板。
 *
 * 和 SideName 分开:自动折叠只会发生在左右两栏(它们是横向抢宽度的),
 * 而计划是竖向和文件树分高度的,窄屏时它跟着左栏一起消失,不单独折叠。
 */
export type PanelName = "tree" | "detail" | "plan"

export interface Layout {
  width: number
  height: number
  tree?: Rect
  /** 左栏下半:计划。有计划、左栏在、且没被收起来时才有 */
  plan?: Rect
  /** 计划下面那一块:还在跑的子 agent。一个都没有时整块不出现 */
  agents?: Rect
  /** 再下面那一块:还活着的后台进程。一个都没有时整块不出现 */
  jobs?: Rect
  chat: Rect
  detail?: Rect
  input: Rect
  /**
   * 斜杠命令的候选区。开着才有。
   *
   * 它是**布局的一部分**,不是浮层 —— 它讲的是输入框里那半句话,和对话、
   * 文件树都没关系,盖在它们身上是错的位置。占了行就把上面的面板挤短一点,
   * 关掉就还回去。
   */
  completion?: Rect
  /** 计划面板上沿那条带标题的横线在第几行;-1 = 没有计划面板 */
  planRule: number
  /** 子 agent 那块上沿的横线;-1 = 没有在跑的子 agent */
  agentRule: number
  /** 后台进程那块上沿的横线;-1 = 没有在跑的任务 */
  jobRule: number
  /**
   * 输入区上沿那条横线在第几行。**只跨中间栏**,不横穿整个界面。
   *
   * 输入一度是横跨三栏的一整带,底下的文件树和详情因此都被截短一截 ——
   * 而那一带里除了输入什么都没有。现在它长在中间栏里当最后一行:输入是
   * 「你对这段对话说的话」,它本来就该和对话同宽、在对话正下方。
   */
  inputRule: number
  /**
   * 收起来的栏留在原地的那条竖轨。点它(或者顶上那个 `[+]`)就展开回来。
   *
   * 只有用户自己收的才有 —— 窄屏自动折叠的那些是因为没地方,见文件头。
   */
  rails: Array<{ panel: PanelName; x: number; y: number; width: number; height: number }>
  /** 状态行在第几行;-1 表示高度不够,没有状态行 */
  statusRow: number
  /**
   * 状态行上沿那条横线在第几行;-1 = 没有状态行。
   *
   * 它**横穿整个界面**(`├──┴──┴──┤`),和输入区那条只跨中间栏的线不同 ——
   * 状态行本来就是全宽的,三栏的竖线必须在这里收口,否则它们会一直插进
   * 状态文字里。
   */
  statusRule: number
  rowTop: number
  rowBottom: number
  /** 所有竖线所在的列,含左右外框 */
  dividers: number[]
  /** 因为太窄被收起来的栏(用户手动关掉的不算) */
  collapsed: SideName[]
}

const TREE = { ideal: 26, min: 16, max: 40 }
/** 收起来的栏留下那条轨有多宽。刚好放得下 `[+]` */
const RAIL = 3
/** 文件树至少留几行。少于这个数它就不是一棵树了,是一行文件名 */
const TREE_MIN_ROWS = 4
/** 计划最多占左栏的多少 */
const PLAN_SHARE = 0.5
/** 后台任务最多占多少。比计划小:它一行一个,而同时最多八个 */
const JOBS_SHARE = 0.3
/** 中间栏至少留几行给正文。看板再热闹也不能把它说的话挤没 */
const CHAT_MIN_ROWS = 6
const DETAIL = { ideal: 54, min: 30, max: 96 }
/** 对话栏低于这个宽度就不值得再分栏 */
const CHAT_MIN = 36

export interface LayoutInput {
  width: number
  height: number
  /** 输入框内容占几行(多行输入会长高) */
  inputHeight: number
  /** 命令候选占几行。0 = 没开 */
  completionHeight?: number
  /** 计划想要几行(不含标题横线)。0 = 这一场还没有计划 */
  planRows?: number
  /** 子 agent 想要几行(不含标题横线)。0 = 没有在跑的 */
  agentRows?: number
  /** 后台进程想要几行(不含标题横线)。0 = 没有在跑的 */
  jobRows?: number
  /** 用户手动关掉的栏:不参与布局,也不算「被折叠」 */
  hidden?: ReadonlySet<PanelName>
}

export function computeLayout(input: LayoutInput): Layout {
  const width = Math.max(20, input.width)
  const height = Math.max(6, input.height)
  const hidden = input.hidden ?? new Set<PanelName>()

  // 竖向:上框 1 + body + 状态那条线 1 + 状态 1 + 下框 1。**输入不再单占一带** ——
  // 它长在中间栏里(见下面 inputRule),两侧的栏因此一直通到底。
  //
  // ★ 状态行**在框里**。它一度画在下框外面那一行,而那一行不属于这个界面里的
  //   任何东西:框外没有边、没有背景、也没有别的东西跟它对齐,读起来像是终端
  //   自己吐的一行日志 —— 而它写的是「我在哪个仓库、什么模式、还剩多少上下文」,
  //   是这个界面最该被当成界面的一行。代价是 body 少一行(那条 `├──┴──┤`),
  //   换来的是竖线在它上面**收口收得干净**:少了那条线,三栏的分隔线会一直
  //   插进状态文字里。
  const showStatus = height >= 8
  const statusRule = showStatus ? height - 3 : -1
  const statusRow = showStatus ? height - 2 : -1
  const bodyHeight = Math.max(1, height - 2 - (showStatus ? 2 : 0))
  const inputHeight = Math.max(1, Math.min(input.inputHeight, Math.max(1, bodyHeight - 2)))
  // 候选区能占的行数以「对话至少留一行」为界。挤没了的话候选框还在,
  // 但界面已经没有内容区了 —— 那种时候宁可少列几条候选
  const completionHeight = Math.max(0, Math.min(input.completionHeight ?? 0, bodyHeight - inputHeight - 2))

  const rowTop = 0
  // 下框在最后一行:状态那两行(线 + 字)夹在 body 和它之间,**都在框里**
  const rowBottom = rowTop + 1 + bodyHeight + (showStatus ? 2 : 0)

  // 横向:先决定留哪几栏,再分宽度
  const collapsed: SideName[] = []
  let wantTree = !hidden.has("tree")
  let wantDetail = !hidden.has("detail")

  const inner = (panes: number) => width - 2 - (panes - 1) // 去掉外框和竖分隔线

  if (wantDetail && inner(2 + (wantTree ? 1 : 0)) - (wantTree ? TREE.min : 0) - DETAIL.min < CHAT_MIN) {
    wantDetail = false
    collapsed.push("detail")
  }
  if (wantTree && inner(2) - TREE.min < CHAT_MIN) {
    wantTree = false
    collapsed.push("tree")
  }

  // 自己收的留一条轨(占 RAIL 列 + 一条竖线);窄屏自动折叠的不留 —— 那时候
  // 正是没地方了。挤到对话栏低于下限时也不留:轨是便利,对话是主体
  const railRoom = (n: number) => inner(1 + n) - (wantTree ? TREE.min : 0) - (wantDetail ? DETAIL.min : 0) >= CHAT_MIN
  let railTree = hidden.has("tree") && !collapsed.includes("tree")
  let railDetail = hidden.has("detail") && !collapsed.includes("detail")
  if (railTree && railDetail && !railRoom((wantTree ? 1 : 0) + (wantDetail ? 1 : 0) + 2 * (1 + RAIL))) {
    railDetail = false
  }
  if (railTree && !railRoom((wantTree ? 1 : 0) + (wantDetail ? 1 : 0) + (railDetail ? 1 + RAIL : 0) + 1 + RAIL)) {
    railTree = false
  }
  if (railDetail && !railRoom((wantTree ? 1 : 0) + (wantDetail ? 1 : 0) + (railTree ? 1 + RAIL : 0) + 1 + RAIL)) {
    railDetail = false
  }

  const treeShown = wantTree || railTree
  const detailShown = wantDetail || railDetail
  const panes = 1 + (treeShown ? 1 : 0) + (detailShown ? 1 : 0)
  const content = inner(panes)
  /**
   * ★ 树最宽能到多少。上限里**必须扣掉右栏要占的那一份**。
   *
   * ── 86 到 95 列之间那个断崖 ──
   * 上面「留哪几栏」是拿 `TREE.min`(16)算的:三栏都按最小值塞得下就留三栏。
   * 而这里分配拿的是 `TREE.ideal`(26) —— 差的那 10 列没有别的来源,全从对话
   * 身上出。86 列时的实际结果是 tree 26 / detail 30 / **chat 26**,而 CHAT_MIN
   * 写着 36。85 列反而好:那时候右栏被判成塞不下、整个收掉,对话拿到 56 列。
   * 也就是说**把窗口拉宽一列,对话栏塌掉一半** —— 而 86~95 正是很常见的
   * tmux 分屏宽度。
   *
   * 修法不是"提前收掉右栏",是让树**缩回它答应过的那个最小值**:决定阶段说的
   * 是"按最小值塞得下",那分配阶段就得兑现这句话。86 列 → 16 / 30 / 36,
   * 三条下限一条不破;宽下去之后树自己长回 26。
   *
   * 下界那个 `Math.max(TREE.min, …)` 是保险:上面的判断已经保证了减完不会
   * 低于 TREE.min,但 clamp(v, lo, hi) 在 hi < lo 时返回的是 hi —— 一旦哪天
   * 判断改了,这里会静默地交出一个比最小值还窄、甚至是负数的宽度。
   */
  const detailFloor = wantDetail ? DETAIL.min : railDetail ? RAIL : 0
  const treeCap = Math.max(TREE.min, Math.min(TREE.max, content - CHAT_MIN - detailFloor))
  const treeWidth = wantTree ? clamp(TREE.ideal, TREE.min, treeCap) : railTree ? RAIL : 0
  const detailRoom = content - treeWidth - CHAT_MIN
  const detailWidth = wantDetail
    ? clamp(Math.min(DETAIL.ideal, detailRoom), DETAIL.min, DETAIL.max)
    : railDetail
      ? RAIL
      : 0
  const chatWidth = content - treeWidth - detailWidth

  const bodyY = rowTop + 1
  /** 中间栏里留给对话的高度:整栏减去输入、候选、和它们上面那条线 */
  const chatHeight = Math.max(1, bodyHeight - inputHeight - completionHeight - 1)
  const inputY = bodyY + bodyHeight - inputHeight
  const dividers = [0]
  let x = 1

  const layout: Layout = {
    width,
    height,
    chat: { x: 0, y: bodyY, width: chatWidth, height: chatHeight },
    input: { x: 0, y: inputY, width: chatWidth, height: inputHeight },
    ...(completionHeight > 0
      ? { completion: { x: 0, y: inputY - completionHeight, width: chatWidth, height: completionHeight } }
      : {}),
    inputRule: inputY - completionHeight - 1,
    planRule: -1,
    agentRule: -1,
    jobRule: -1,
    rails: [],
    statusRow,
    statusRule,
    rowTop,
    rowBottom,
    dividers,
    collapsed,
  }

  if (treeWidth > 0) {
    if (railTree) layout.rails.push({ panel: "tree", x, y: bodyY, width: treeWidth, height: bodyHeight })
    else layout.tree = { x, y: bodyY, width: treeWidth, height: bodyHeight }
    x += treeWidth
    dividers.push(x)
    x += 1
  }
  // 中间栏的 x 定下来之后,长在它里面的那两块也跟着挪 —— 它们在字面量里
  // 只能先占位(chatWidth 那时候还没排到位置)
  layout.chat.x = x
  layout.input.x = x
  if (layout.completion) layout.completion.x = x
  // 中间栏自上而下切成:对话 / 计划 / 输入。
  //
  // 工具**不在这儿分地** —— 它不是一块面板,是回答过程的一部分,和正文一起
  // 长在对话里(见 panes/chat.ts 的看板)。它一度是块独立面板,那让「它现在
  // 动的是哪只手」变成了一个要单独去看的地方,而那件事本来就该在正文旁边。
  let room = chatHeight
  const planHeight = splitRows(room, input.planRows ?? 0, hidden.has("plan"), CHAT_MIN_ROWS, PLAN_SHARE)
  // 收起来的只留标题那一行(planRule 有、plan 没有)—— 那一行右端是个 `[+]`
  const planStub = planHeight === 0 && hidden.has("plan") && (input.planRows ?? 0) > 0 && room > CHAT_MIN_ROWS
  const planBlock = planHeight > 0 ? planHeight + 1 : planStub ? 1 : 0
  room -= planBlock

  // 计划**下面**依次是:子 agent、后台进程。三块都是「状态」不是「内容」,
  // 所以都钉在输入框上方;顺序按"离这段对话有多近"排 —— 计划是我接下来要干的,
  // 子 agent 是我派出去替我干的,后台进程只是还占着机器的东西。
  //
  // 挤的时候先牺牲最下面那块:它们都**只在真有东西跑着的时候才存在**,
  // 没了也不会留下空壳
  const agentHeight = splitRows(room, input.agentRows ?? 0, false, CHAT_MIN_ROWS, JOBS_SHARE)
  const agentBlock = agentHeight > 0 ? agentHeight + 1 : 0
  room -= agentBlock

  const jobHeight = splitRows(room, input.jobRows ?? 0, false, CHAT_MIN_ROWS, JOBS_SHARE)
  const jobBlock = jobHeight > 0 ? jobHeight + 1 : 0
  room -= jobBlock

  layout.chat.height = room
  if (planBlock > 0) {
    layout.planRule = bodyY + room
    if (planHeight > 0) layout.plan = { x, y: layout.planRule + 1, width: chatWidth, height: planHeight }
  }
  if (agentBlock > 0) {
    layout.agentRule = bodyY + room + planBlock
    layout.agents = { x, y: layout.agentRule + 1, width: chatWidth, height: agentHeight }
  }
  if (jobBlock > 0) {
    layout.jobRule = bodyY + room + planBlock + agentBlock
    layout.jobs = { x, y: layout.jobRule + 1, width: chatWidth, height: jobHeight }
  }
  x += chatWidth
  if (detailWidth > 0) {
    dividers.push(x)
    x += 1
    if (railDetail) layout.rails.push({ panel: "detail", x, y: bodyY, width: detailWidth, height: bodyHeight })
    else layout.detail = { x, y: bodyY, width: detailWidth, height: bodyHeight }
    x += detailWidth
  }
  dividers.push(width - 1)

  return layout
}

/**
 * 被折叠的栏临时召回时盖在哪。
 *
 * 盖住对话而不是挤走它 —— 挤走会让整个界面在按一下键时全部重排,眼睛要重新
 * 找位置。盖上去只是多一层,关掉就恢复原样。
 */
export function overlayRect(which: SideName, layout: Layout): Rect {
  const size = which === "tree" ? TREE : DETAIL
  const panelWidth = clamp(size.ideal, size.min, Math.max(size.min, layout.width - 6))
  const width = Math.min(panelWidth, layout.width - 2)
  return {
    x: which === "tree" ? 1 : Math.max(1, layout.width - 1 - width),
    y: layout.rowTop + 1,
    width,
    height: layout.rowBottom - layout.rowTop - 1,
  }
}

/**
 * 一栏切成上下两块时,下面那块分几行。
 *
 * 想要多少给多少,但夹在三条线之间:上面那块至少留 keep 行、下面最多占 share、
 * 还要给那条标题横线留一行。剩不下一行就整块不出现 —— 一个只画得下半条内容的
 * 面板,比没有这个面板更让人以为内容就是那么少。
 */
function splitRows(bodyHeight: number, want: number, hidden: boolean, keep: number, share: number): number {
  if (hidden || want <= 0) return 0
  const room = Math.min(want, Math.floor(bodyHeight * share), bodyHeight - 1 - keep)
  return room >= 1 ? room : 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export const LAYOUT_LIMITS = { TREE, DETAIL, CHAT_MIN, TREE_MIN_ROWS, CHAT_MIN_ROWS }
