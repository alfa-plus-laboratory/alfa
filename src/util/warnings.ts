/**
 * 进程告警一律进日志文件,绝不落终端。
 *
 * ── 为什么 ──
 * 全屏界面是个**差分**合成器:它手里存着"屏幕现在长什么样",每帧只发变化的那几格。
 * 一条不经过它的写入会把光标顶走、把行推上去,而合成器**不知道这件事发生过** ——
 * 于是从那一刻起它算出来的差分全是错的:屏幕不会自己恢复,后面每一帧都在一个错位
 * 的底子上继续画。用户看到的现象是边框断在半截、文字互相穿插,而且越用越烂。
 *
 * 真机上出过一次:agentflow 跑着的时候一条 TimeoutOverflowWarning 连着栈糊在界面
 * 中间,整个下半框就歪了(那条告警的来源已经从源头修掉,见 tool/bash.ts 的
 * MAX_TIMEOUT_MS —— 但下一条告警总会从别处来,所以这条通道本身也得堵上)。
 *
 * ── 为什么是"挂一个监听器",而不是接管 stderr ──
 * 在 Bun 上试过:补 `process.stderr.write` 拦不住这类告警,**连 console.error 都
 * 拦不住** —— 它们在原生层直接往 fd 2 写。而只要 `warning` 事件上挂着任何一个
 * 监听器,Bun 就不再自己打印(默认打印不是一个 JS 监听器,所以也没法按 Node 的
 * 老办法 removeAllListeners 掉)。也就是说:**接不住,只能不让它产生**,
 * 而挂监听器正好同时做到两件事 —— 打印没了,内容还拿得到。
 *
 * llm/stream.ts 里对 AI SDK 的告警走的是同一条思路(在它发出来之前改道)。
 * 这两处合起来是这个进程里**唯二**决定"告警去哪"的地方。
 *
 * ⚠ **上面那条"挂了监听器 Bun 就不再自己打印"在 bun 1.4.0 上不成立了。**
 *   1.4.0 会两边都做:监听器照收,同时照样往 fd 2 打一遍。也就是说这个文件在
 *   1.4.0 上只剩"内容拿得到",防撕那一半没了。
 *
 *   试过的三条,只有第三条管用:
 *     - 覆盖 `process.emitWarning` —— 拦不住,它在原生层直接写 fd 2
 *     - 进程内设 `process.env.NODE_NO_WARNINGS = "1"` —— 太晚,启动时就读过了
 *     - **进程启动前**就带着 `NODE_NO_WARNINGS=1` —— 打印没了,监听器照样收到
 *   而第三条对一个 `--compile` 出来的单文件二进制没有落点:没有外面那层壳去设
 *   这个变量,除非自己 re-exec 一次(会把 stdio 和 TTY 一起搅乱,不划算)。
 *
 *   所以现在的做法是**不升 bun**:CI 里 `bun-version` 已经钉死在 1.3.14
 *   (见 .github/workflows/release.yml 那段 ★ —— 那一行决定的是发出去的二进制
 *   里嵌的是哪个 runtime,不只是拿什么构建)。test/warnings.test.ts 那两条是
 *   这件事的哨兵:哪天想升 bun,它们会先红,而红的原因就写在这儿。
 */
import { logger } from "./log.ts"

const log = logger("warn")

let installed = false

/**
 * 装一次就够。启动时调用,不跟着全屏进出走 —— `--plain` 的活动区一样会被撕开,
 * 而 `-p` 那条路上告警混进输出里同样没有意义。
 */
export function captureWarnings(): void {
  if (installed) return
  installed = true
  process.on("warning", (warning: Error) => {
    log.warn(warning.name || "warning", { message: warning.message, stack: warning.stack })
  })
}
