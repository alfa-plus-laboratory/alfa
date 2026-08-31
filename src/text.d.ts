/**
 * 用 `with { type: "text" }` 导进来的文件。
 *
 * 预制 skill 的正文走这条路:它们是真的 `.md` 文件(和用户写的那些同一种东西),
 * 而 `bun build --compile` 会把它们嵌进二进制,所以单文件分发不受影响。
 */
declare module "*.md" {
  const content: string
  export default content
}
