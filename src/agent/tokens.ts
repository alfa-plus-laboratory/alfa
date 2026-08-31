/**
 * 上下文用量计算。
 *
 * M1 只用它出警告,但口径现在就要定死:等到接压缩时再定,压缩会在错误的
 * 时机触发,而且这种错误不会报错,只会表现为「怎么老是自己丢上下文」。
 */
import type { ModelInfo, Tokens } from "../llm/types.ts"

/**
 * 留给压缩本身和下一轮回答的余量。
 *
 * 压缩不是免费的:它自己要发一次请求(把历史读进去),生成的摘要还要占位置。
 * 卡到极限才压,压缩请求本身就会超限 —— 那就彻底死锁了。
 */
export const COMPACTION_BUFFER = 20_000

/** provider 偶尔会给 undefined / NaN / 负数,一律当 0。 */
export function safe(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 这一轮实际占了多少上下文 —— **不含** output。
 *
 * output 已经落进历史,会在下一轮以 input 的身份重新计一遍;这里再加一次
 * 就是重复计数。
 */
export function contextTokens(tokens: Tokens | undefined, info?: Pick<ModelInfo, "cacheInInput">): number {
  if (!tokens) return 0
  const input = safe(tokens.input)
  const cached = safe(tokens.cache?.read) + safe(tokens.cache?.write)
  // 口径见 ModelInfo.cacheInInput。缺省按 Anthropic 系(相加)算 —— 宁可高估。
  return info?.cacheInInput ? Math.max(input, cached) : input + cached
}

/**
 * 窗口的一成。**大窗口按比例留,小窗口按绝对值留。**
 *
 * 100 万的窗口留 5 万等于没留:一次 read 就能吃掉它,而压缩本身要把整段历史
 * 读进去。所以留一成 —— 1M 的窗口以 900k 为满,这也是状态行上那个百分比的
 * 分母。反过来,20 万的窗口留一成只有 2 万,连一次压缩请求都装不下,那时候
 * 还是得按下面那个绝对值算。
 */
const HEADROOM = 0.1

/**
 * 扣掉输出预算和压缩余量之后,真正能用来装历史的额度。**这就是 100% 那条线。**
 *
 * 显示和判溢出用的是同一个函数:两处各算一套的话,状态行会写着 87%,而模型
 * 那边已经在报 context overflow 了。
 */
export function usable(limit: ModelInfo["limit"]): number {
  const floor = Math.min(limit.output, 32_000) + COMPACTION_BUFFER
  const reserved = Math.max(Math.ceil(limit.context * HEADROOM), floor)
  return Math.max(0, limit.context - reserved)
}

export function isOverflow(tokens: Tokens | undefined, info: ModelInfo): boolean {
  const budget = usable(info.limit)
  if (budget === 0) return false
  return contextTokens(tokens, info) >= budget
}

/** 0–1 的占用率,给状态行画进度用。 */
export function usageRatio(tokens: Tokens | undefined, info: ModelInfo): number {
  const budget = usable(info.limit)
  if (budget === 0) return 0
  return Math.min(1, contextTokens(tokens, info) / budget)
}

/**
 * 把多个 step 的用量加起来 —— **只用于计费,绝不能用于上下文占用**。
 *
 * 每个 step 的 input 都含整段历史,所以跨 step 相加得到的是「累计读了多少
 * token」(账单口径),不是「现在占了多少上下文」。拿它去判断溢出,一个
 * 十步的 turn 会被算成十倍,压缩会在完全没必要的时候触发。
 *
 * 上下文占用请用**最后一个 step** 的 tokens 过 contextTokens()。
 */
export function accumulateBilled(a: Tokens | undefined, b: Tokens | undefined): Tokens {
  const left = a ?? emptyTokens()
  const right = b ?? emptyTokens()
  const total = safe(left.total) + safe(right.total)
  return {
    input: safe(left.input) + safe(right.input),
    output: safe(left.output) + safe(right.output),
    reasoning: safe(left.reasoning) + safe(right.reasoning),
    cache: {
      read: safe(left.cache?.read) + safe(right.cache?.read),
      write: safe(left.cache?.write) + safe(right.cache?.write),
    },
    ...(total > 0 ? { total } : {}),
  }
}

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

/**
 * 从库里的历史重建「这一场到目前为止花了多少」。
 *
 * ── 为什么必须扫 step-finish part,不能读消息级的 tokens ──
 * 消息上那个 `tokens` 存的是**占用**(processor.ts 里 `message.tokens =
 * this.contextTokens`,取的是最后一个 step),不是累计花费。拿它当账单用,
 * 一个跑了十步的 turn 只会被算成最后一步那一份。
 *
 * 花费在每个 step-finish part 上,而它们每一条都落了库 —— 加起来才是账。
 *
 * ★ 形状故意写成鸭子类型:这一层不该认识 session 的 schema,而它要的只是
 *   「有 parts、part 上可能有 tokens」这一件事。
 */
export function billedFromHistory(
  history: readonly { parts: readonly { type: string; tokens?: Tokens }[] }[],
): Tokens {
  let out = emptyTokens()
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type === "step-finish" && part.tokens) out = accumulateBilled(out, part.tokens)
    }
  }
  return out
}
