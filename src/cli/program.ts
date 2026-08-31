/**
 * 命令行上打的那个名字。
 *
 * ── 为什么不写死 ──
 * 名字现在只有一个(`alfa`),但帮助里印的仍然是**用户刚才敲进来的那一串**。
 * 理由是这个二进制会以别的名字被调起:自己做的软链、shell alias、以及改名前
 * 装过 `apcode` 的那批机器上还留着的旧软链。写死的话,那些人抄到的是一条
 * **他机器上不存在**的命令 —— command not found,而他刚刚才成功运行了它。
 *
 * ── 为什么是 argv0 不是 argv[1] ──
 * 单文件二进制里 `process.argv[1]` 是 **构建时**的产物名(`/$bunfs/root/xxx-bin`),
 * 无论从哪个软链进来都一样,拿它等于写死。`process.argv0` 才是 shell 传进来的
 * 那一串 —— 从 `alfa` 这个软链进来就是 `alfa`,从旧的 `apcode` 进来就是 `apcode`。
 *
 * 用 bun 直接跑源码时 argv0 是 `bun`,这时候退回 argv[1](那是脚本路径)。
 */
import { basename } from "node:path"

/** 产品名。配置目录、system prompt 里的自称用它,不随调用方式变。 */
export const PRODUCT = "alfa"

export function programName(): string {
  const invoked = basename(process.argv0 ?? "")
  if (invoked.length > 0 && invoked !== "bun" && invoked !== "node") return invoked
  const script = basename(process.argv[1] ?? "")
  return script.length > 0 ? script : PRODUCT
}
