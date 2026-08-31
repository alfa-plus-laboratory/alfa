/**
 * 同时能派几个子 agent。
 *
 * ── 为什么这几个数单独一个文件 ──
 * 它们有三个读者,而三个都不该为了几个常数把整台调度器拖进来:调度器自己
 * (agent/subagent.ts)、配置校验(config/config.ts:`"agentflow": 6` 合不合法)、
 * 以及 `/agentflow` 那条命令(cli/main.ts:参数范围、提示语)。config 去 import
 * subagent.ts 的话,一个只想读 JSON 的模块会顺着 Loop 把半个程序连进来,
 * 而且离一个 import 环只差一步。
 *
 * ── 为什么"窗口"和"总量"是两个数 ──
 * 窗口挡的是**同一时刻发多少请求**:每一个子 agent 都在真金白银地发,而且和主
 * 对话抢同一个 provider 的限流额度 —— 起十六个的结果通常不是快十六倍,是主对话
 * 开始撞 429。总量挡的是**账单**:排队的那些不发请求,但队里每一个迟早都要跑完
 * 一整场自己的会话。没有后面这道栏,一个理解错了的模型可以一轮 turn 里排进
 * 两百个,而它们会一个不落地跑完。
 */

/** 缺省窗口(agentflow 关着)。四个已经够覆盖"分头看三个模块"这类真实用法 */
export const MAX_AGENT_JOBS = 4

/** agentflow 开着的缺省窗口 */
export const FLOW_WINDOW = 6

/**
 * 窗口能调到多大。
 *
 * 上限 12 不是随便定的:再往上,瓶颈从"活儿够不够分"变成 429,而那时候多出来的
 * 那几个不但没有让事情变快,还会把**主对话**一起拖下水 —— 用户看到的是自己
 * 打的字换来一句限流报错。
 */
export const FLOW_WINDOW_MIN = 2
export const FLOW_WINDOW_MAX = 12

/**
 * 同时挂着(排队 + 在跑)最多几个:关着的时候 / 开着的时候。
 *
 * ★ 开着的时候这个数**要大**。它一度是 24,而那正好把这个功能卡在半路上:
 *   「一百个文件各查一遍」「二十个模块分头摸清楚」这类活儿本来就是它存在的
 *   理由,拦在 24 上等于告诉模型"别拆那么细" —— 于是它退回去自己干。窗口
 *   (同时几个在发请求)才是限流那道栏,而这道栏只是不让一次跑飞。
 */
export const MAX_ALIVE_JOBS = 8
export const MAX_FLOW_ALIVE_JOBS = 100

/** 配置/命令行给的那个值算不算一个合法的窗口 */
export function isFlowWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FLOW_WINDOW_MIN &&
    value <= FLOW_WINDOW_MAX
  )
}
