/**
 * Files imported with `with { type: "text" }`.
 *
 * Built-in skill bodies come in this way: they are real `.md` files (the same kind of
 * thing as the ones users write), and `bun build --compile` embeds them into the binary,
 * so single-file distribution is unaffected.
 */
declare module "*.md" {
  const content: string
  export default content
}
