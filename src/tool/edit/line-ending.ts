/**
 * 行尾与 BOM 的探测/还原。
 *
 * 三个坑:
 * 1. BOM —— 默认的 TextDecoder 会**吃掉** U+FEFF,读进来看不见、写回去就丢了,
 *    在 Windows 团队的仓库里会造成整文件 diff。必须 { ignoreBOM: true }。
 * 2. 行尾 —— 模型给的 oldString/newString 用什么行尾都不可控。策略是全部归一
 *    成 LF 做匹配,写回时按**文件原有风格**展开。文件级一票制:只要出现过一次
 *    CRLF 就整个文件当 CRLF 处理(混合行尾的文件本来就该被统一)。
 * 3. **非 UTF-8** —— 见 decodeWithBomStrict。会**改一段、写回整个文件**的调用方
 *    (edit)必须用严格那个,否则文件里每一个不合法字节都被换成 U+FFFD 写回去。
 */

export const BOM = "﻿"

export interface BomSplit {
  text: string
  bom: string
}

/** 剥掉开头的 BOM,分开返回。 */
export function bomSplit(input: string): BomSplit {
  return input.startsWith(BOM) ? { text: input.slice(BOM.length), bom: BOM } : { text: input, bom: "" }
}

export function bomJoin(text: string, bom: string): string {
  if (!bom) return text
  return text.startsWith(BOM) ? text : bom + text
}

/**
 * 用能看见 BOM 的方式解码文件字节。**宽松** —— 不合法的字节变 U+FFFD。
 *
 * 只给「拿旧内容算个 diff 给人看」这种用途(write 工具:它整份覆盖,不回写
 * 任何它没读懂的东西)。要把解码结果**再写回文件**的,一律用下面那个严格的。
 */
export function decodeWithBom(bytes: Uint8Array): BomSplit {
  return bomSplit(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

/** 文件不是合法 UTF-8。edit 拒绝往下走时抛它 */
export class NotUtf8Error extends Error {
  constructor(display: string) {
    super(
      `${display} is not valid UTF-8, so edit cannot safely modify it. ` +
        `Editing decodes the whole file, replaces in text, and writes the whole file back — ` +
        `every byte it could not decode would be replaced with U+FFFD, including on lines this edit does not touch. ` +
        `Do not retry this edit. Tell the user the file's encoding needs converting first (e.g. iconv), or use a shell command that works on bytes.`,
    )
    this.name = "NotUtf8Error"
  }
}

/**
 * 严格解码:不是合法 UTF-8 就抛。
 *
 * ★ 为什么 edit 必须用这个 ──
 *   edit 的形状是「整份解码 → 在字符串里替换 → 整份写回」。宽松解码把每一个
 *   不合法字节变成 U+FFFD,而写回时它们就以 U+FFFD 的字节存下去 —— **原字节
 *   永久没了**。而且:
 *
 *   - `fs/binary.ts` 把 ≥0x80 的字节算成可打印,所以 Latin-1 / Shift-JIS / GBK
 *     文件能通过 read 和新鲜度检查,模型完全看不出问题;
 *   - 被毁掉的字节往往**在 edit 根本没碰的那一行上**;
 *   - 审批 diff 是从**已解码**文本算的,所以那处破坏在批准界面上**看不见**。
 *
 *   三条凑在一起 = 一次看起来完全正常的编辑,悄悄改坏了文件的另一部分。
 *   所以这里 fail closed:宁可拒绝编辑,也不猜用户的编码。
 */
export function decodeWithBomStrict(bytes: Uint8Array, display: string): BomSplit {
  let text: string
  try {
    text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes)
  } catch {
    throw new NotUtf8Error(display)
  }
  return bomSplit(text)
}

export type LineEnding = "\n" | "\r\n"

/** 文件级一票制:出现过 CRLF 就是 CRLF。 */
export function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n")
}

export function convertToLineEnding(content: string, ending: LineEnding): string {
  const lf = normalizeLineEndings(content)
  return ending === "\n" ? lf : lf.replaceAll("\n", "\r\n")
}
