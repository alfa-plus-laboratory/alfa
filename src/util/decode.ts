/**
 * 子进程输出的 UTF-8 流式解码。
 *
 * ── ★ 一条流一个,**绝不能两条流共用** ──
 * 一个多字节字符会被管道从中间劈开:「你」是 `e4 bd a0` 三个字节,64 KB 的
 * 管道边界正好落在里面是常态。`TextDecoder` 的 `{ stream: true }` 就是为这个
 * 存在的 —— 它把半个字符的状态**存在解码器里**,等下一块来了再拼上。
 *
 * ⚠ 于是"存在解码器里"这件事,在 stdout 和 stderr 共用一个解码器时变成 bug:
 *
 *     stdout: e4 bd      ← 解码器攒着半个「你」
 *     stderr: "ERR\n"    ← 用同一个解码器解,那半个字符被当成它的前缀
 *     stdout: a0         ← 再来的这一个字节已经无家可归
 *
 *   出来的是 `<?>ERR<?>` 而不是「你」。**两条流都被弄脏了**,而且脏在
 *   一个和它们各自内容都无关的地方。
 *
 *   这不是边角:任何一边往 stderr 写进度、另一边输出中日韩文本的构建工具
 *   (webpack、vite、gradle、cargo 的中文 locale)都会遇上。
 *
 * ── 为什么不是 `String(chunk)` / `chunk.toString()` ──
 * 那两个是**一次性**解码,没有跨块状态:劈开的那个字符两边各得到一个 U+FFFD,
 * 而且是静默的。看起来比共用解码器"干净",其实是同一个 bug 的另一种写法 ——
 * 它只是从不把错误扩散到另一条流而已。
 */

/**
 * 造一个只属于**一条**流的解码函数。
 *
 * 每条流各调一次:
 *
 *     proc.stdout?.on("data", pump(streamDecoder()))
 *     proc.stderr?.on("data", pump(streamDecoder()))
 */
export function streamDecoder(): (chunk: Buffer | string) => string {
  const decoder = new TextDecoder("utf-8")
  // 已经是字符串就别再过一遍解码器 —— 那会把它当成 latin-1 字节重新解一次。
  // 子进程按理只给 Buffer,但流的 encoding 是可以在外面被设过的
  return (chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }))
}
