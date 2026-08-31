/**
 * 中间栏的高度预算。纯函数,只算行数,不认识终端。
 *
 * ── 三段各有一条带标签的横线 ──
 *
 *   so far ─────────      摘要:回来的时候先看它
 *   <一段话>
 *   you ────────────      你说的那句话,**钉在摘要正下方**
 *   ▌ 帮我改一下 live.ts
 *   plan ─────── 2/5      它打算怎么干(有 todo 调用才出现)
 *   ✓ 读一遍渲染器
 *   ▸ 把滚动条拆出去
 *   now ────────────      正在发生的事
 *   ⠹ 思考中… 12s
 *   <它说的话>
 *   <空>                  ← 多出来的高度落在这里
 *   ⠹ bash  npm test      工具:只留最新的一两条,贴着底
 *   ⠹ working · 12.4s     状态
 *
 * 每段一条标签横线,是因为各段的内容都是「一段普通文字」——摘要和提问不靠
 * 缩进、不靠颜色就分不开(它们本来就揉在一起过一次)。标签比纯横线贵一个字,
 * 但省掉「这行是谁说的」这个问题。
 *
 * ── 计划为什么排在提问**下面** ──
 * 提问是钉在摘要正下方的锚点。把计划插到它们中间的话,提问的位置会随着计划
 * 长短上下漂 —— 而一个会自己移动的锚点等于没有锚点。计划排在它下面,于是
 * 一轮之内它上面的行数是固定的。
 *
 * ── 空白留在哪 ──
 * **留在活动区里面**,正文和工具行之间。所以:摘要和提问在上面钉死不动,
 * 工具行贴着下面的输入框,中间那片空地是留给正在长出来的正文的。
 * 空白留在提问上面的话,提问会随着回答变长而往上飘 —— 一个会自己移动的
 * 锚点等于没有锚点。
 *
 * ── 挤的时候先牺牲谁 ──
 * 摘要 → 提问 → 计划 → 活动区。摘要是「回头看」,窄屏上它可以完全消失
 * (还有 /summary);提问就在上面几行的输入框里刚打过;计划是「接下来还有
 * 什么」,它比前两样都更难从别处得知,所以留到最后。活动区是「正在发生」,
 * 它一格都不能少 —— 一个看不见自己在干什么的 agent 比没有界面更吓人。
 */

export interface ZoneInput {
  height: number
  /** 摘要正文折行后的行数,不含标签行。0 = 还没有摘要 */
  summaryLines: number
  /** 提问块的行数(已经由调用方截到 MAX_PROMPT_LINES)。0 = 还没发过话 */
  promptLines: number
  /** 计划的条数(已经由调用方截到 MAX_PLAN_LINES)。0 = 这一场还没有计划 */
  planLines: number
  /** 看板想要几行(调用方已经按上限截过) */
  boardRows: number
  /** 正文 + 思考指示器一共几行 */
  speechLines: number
  /** 跑着的时候底部留一行:在干嘛 · 多久了 · 怎么停 */
  busy: boolean
}

export interface Zones {
  /** 含 `so far ───` 那一行。0 = 这一栏不显示 */
  summary: number
  /** 含 `you ───` 那一行。0 = 不显示 */
  prompt: number
  /** 含 `plan ───` 那一行。0 = 不显示 */
  plan: number
  /** `now ───` 那一行,0 或 1 */
  liveRule: number
  speech: number
  /** 正文和工具行之间的空白 —— 工具行靠它贴住底部 */
  pad: number
  board: number
  status: number
}

/** 活动区最少留几行。低于这个数就别装了,先把上面两段砍掉 */
const MIN_LIVE = 3
/**
 * 摘要少于这么多行就整段撤掉(标签行 + 至少两行正文)。
 *
 * 只放得下一行的话,用户看到的是一句被腰斩的话 —— 那比没有更糟:他会以为
 * 摘要就是这么写的,而不是「这里放不下」。要看全文有 /summary。
 */
const MIN_SUMMARY = 3
/** 提问最多显示几行,再长就 `…` —— 它是提醒,不是重读 */
export const MAX_PROMPT_LINES = 3
/**
 * 计划最多显示几条。
 *
 * 再多这一栏就变成一份待办清单界面了,而它只该回答「现在在第几步、后面还有
 * 什么」。装不下的部分由 planWindow 以进行中那条为中心开窗,横线上写还剩几条。
 */
export const MAX_PLAN_LINES = 5
/** 摘要最多占中间栏的多少 */
const SUMMARY_SHARE = 0.45

export function zones(input: ZoneInput): Zones {
  const height = Math.max(0, input.height)
  if (height === 0) return { summary: 0, prompt: 0, plan: 0, liveRule: 0, speech: 0, pad: 0, board: 0, status: 0 }

  /**
   * 最底下那一行只在跑的时候留。
   *
   * 它一度常驻,那是因为小机器人住在上面 —— 一轮结束就连人带行一起消失,
   * 每答完一句界面抖一下。现在他搬到活动区那条横线上当标题了(那条线不随
   * busy 来去),这一行剩下的全是**只有在跑的时候才成立**的东西:秒表、
   * 「esc 打断」。空闲时留一行空的没有意义,还得从活动区身上要。
   */
  const status = input.busy && height >= 2 ? 1 : 0

  const promptWant = input.promptLines > 0 ? 1 + input.promptLines : 0
  const planWant = input.planLines > 0 ? 1 + Math.min(input.planLines, MAX_PLAN_LINES) : 0
  const summaryWant =
    input.summaryLines > 0 ? Math.min(1 + input.summaryLines, Math.floor(height * SUMMARY_SHARE)) : 0

  let prompt = promptWant
  let plan = planWant
  let summary = summaryWant
  const liveFloor = MIN_LIVE + status
  /** 上面几段有任何一段活着,活动区就要有自己的标签行 */
  const ruleFor = () => (summary > 0 || prompt > 0 || plan > 0 ? 1 : 0)
  let liveRule = ruleFor()
  const over = () => summary + prompt + plan + liveRule + liveFloor > height

  // 摘要先让:剩不下 MIN_SUMMARY 行就整段撤掉,别留半句话在那儿
  if (over()) {
    summary = Math.max(0, height - prompt - plan - liveRule - liveFloor)
    if (summary < MIN_SUMMARY) summary = 0
    liveRule = ruleFor()
  }
  // 还不够就轮到提问 —— 它就在下面几行的输入框里刚打完,是这几段里最容易
  // 从别处得知的一条
  if (over()) {
    prompt = Math.max(0, height - summary - plan - liveRule - liveFloor)
    if (prompt < 2) prompt = 0
    liveRule = ruleFor()
  }
  // 再不够才动计划。它排最后是因为「后面还有什么」没有别的地方看得到
  if (over()) {
    plan = Math.max(0, height - summary - prompt - liveRule - liveFloor)
    if (plan < 2) plan = 0
    liveRule = ruleFor()
  }
  // 三段都没了还不够,那就只剩活动区
  if (over()) {
    summary = 0
    prompt = 0
    plan = 0
    liveRule = 0
  }

  const body = Math.max(0, height - summary - prompt - plan - liveRule - status)
  const { speech, board } = split(body, input.speechLines, input.boardRows)
  return { summary, prompt, plan, liveRule, speech, pad: Math.max(0, body - speech - board), board, status }
}

/**
 * 活动区内部怎么分。
 *
 * 看板先占位,但**最多占一半** —— 它平时只有一两行(见 chat.ts 的 BOARD_ROWS),
 * 这个上限只是防止调用方哪天传进来一个大数就把正文饿死。正文拿走剩下的,
 * 用不完的部分再还给看板。空白全落在两者之间:工具行因此贴着下面的输入框,
 * 眼睛不用每次去找它跑到哪儿了。
 */
function split(body: number, speechLines: number, boardRows: number): { speech: number; board: number } {
  if (body <= 0) return { speech: 0, board: 0 }
  const reserved = Math.min(boardRows, Math.max(1, Math.floor(body / 2)))
  const speech = Math.min(Math.max(0, speechLines), body - reserved)
  return { speech, board: Math.min(boardRows, body - speech) }
}
