/**
 * `/init`:把「这个项目怎么干活」落成一个文件。
 *
 * ── 为什么需要它 ──
 * instructions.ts 那一套(AGENTS.md / CLAUDE.md)是**读**的一半,一直以来只有
 * 这一半:文件在就装进 prompt,不在就当没有。而绝大多数仓库里它就是不在 ——
 * 于是每一场新会话都从零开始猜这个项目怎么 build、怎么测、哪些约定不能破,
 * 猜错的代价一场比一场重复得更彻底。
 *
 * `/init` 是**写**的那一半。它一次性把上一场攒下来的东西钉在磁盘上,让下一场
 * 一开口就已经知道。这个循环闭上之后,prompt 才开始随项目长大,而不是每次
 * 重置成出厂设置。
 *
 * ── 两件事,一件由代码做,一件由模型做 ──
 * 文件夹是代码建的:它每次长得一模一样,不该由一个可能中途改主意的模型来摆。
 * AGENTS.md 是模型写的:它的内容只有把这个仓库读一遍才答得出来,没有任何
 * 模板能替代。
 *
 * ── 为什么约定文件在根上而不在 .alfa/ 里 ──
 * AGENTS.md 是**跨工具**的约定,Cursor、Codex、Claude Code 都读它。放进我们
 * 自己的文件夹等于把它私有化 —— 用户为这个项目写的那段话,换个工具就得再写
 * 一遍。`.alfa/` 只装真正属于 alfa 自己的东西。
 */
import { existsSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { join } from "node:path"

/** alfa 在项目里的落脚处。 */
export const ALFA_DIR = ".alfa"

/** 约定文件的名字。和 instructions.ts 的 PROJECT_FILENAMES[0] 是同一个东西。 */
export const AGENTS_FILE = "AGENTS.md"

/**
 * `.alfa/README.md` 的全文。
 *
 * ── 为什么一个空文件夹不够 ──
 * 一个凭空出现在 `git status` 里、里面什么都没有的点目录,只会让人删掉它 ——
 * 而且删得有道理。文件夹得自己说清楚自己是干什么的,以及**现在还没干什么**:
 * 后面三行里那些路径今天一个都没人读,写出来是路线图,不是功能说明。把没做的
 * 说成做了的文档,比没有文档更贵。
 */
export const ALFA_README = `# .alfa

alfa's folder for this project, created by \`/init\`.

Project conventions do **not** live here — they live in \`AGENTS.md\` at the
repository root, because every other coding agent reads that file too. This
folder is only for the things that are alfa's own.

| path          | what goes here                                              | live? |
| ------------- | ----------------------------------------------------------- | ----- |
| \`memory/\`     | what alfa has worked out about this project over time      | yes   |
| \`skills/\`     | playbooks — how *this* project does a recurring job          | yes   |
| \`mcp.json\`    | which MCP servers this project uses                          | yes   |
| \`config.json\` | project-level settings (model, check command, and the like)  | no    |

\`memory/\` is one markdown file per note, written by alfa through its \`memory\`
tool and loaded automatically at the start of every later session in this project.
They are ordinary files: read them, and delete one you disagree with — that is the
intended way to correct it.

\`skills/\` is one playbook per file (\`<name>.md\`, or \`<name>/SKILL.md\` when it needs
to carry scripts or templates alongside it). Start each one with a \`---\` block giving
a one-line \`description\`: that line is all alfa sees until it opens the skill, and
opening it is a deliberate step it takes when the work matches. Write the playbook you
would give a new colleague — the sequence, the gotchas, what "done" looks like — not
things that belong in \`AGENTS.md\` (rules that always apply) or \`memory/\` (facts).

The other two are listed so that a folder appearing in \`git status\` is not a
mystery. Nothing reads them yet.

Commit this folder if you want your team to share what ends up in it.
`

export interface InitScaffold {
  /**
   * 这一次**真正建出来的**东西,相对项目根。已经在的不列。
   *
   * 报一个没发生的动作是骗人:第二次 `/init` 说「建了 .alfa/README.md」的话,
   * 用户会以为自己写在里面的东西被盖掉了。
   */
  created: string[]
  /** 建不出来的原因(只读挂载、没权限)。有它就不该说建好了 */
  failed?: string
}

/**
 * 建 `.alfa/`。已经在的原样不动。
 *
 * README 存在就**不覆盖** —— 用户往里加过字是完全正常的事,而一条把它冲掉的
 * 命令用户只会遇到一次,之后再也不敢按。
 */
export function initScaffold(root: string): InitScaffold {
  const created: string[] = []
  try {
    const dir = join(root, ALFA_DIR)
    ensureDirSync(dir)
    const readme = join(dir, "README.md")
    if (!existsSync(readme)) {
      writeFileSync(readme, ALFA_README)
      created.push(`${ALFA_DIR}/README.md`)
    }
  } catch (error) {
    return { created, failed: (error as Error).message }
  }
  return { created }
}

export interface InitPromptInput {
  /** 项目根。约定文件写在它下面 */
  root: string
  /** 已经有一份了。措辞得跟着变 —— 「写一份」和「把现有这份改好」是两件事 */
  existing: boolean
  /** `/init` 后面跟着的那句话。用户想让它重点看什么 */
  note?: string
}

/**
 * 交给模型的那段话。
 *
 * ── 为什么写这么长 ──
 * 因为 AGENTS.md 写坏的方式有很多种,而每一种都要专门拦一下:抄一遍目录树、
 * 写一堆放之四海皆准的废话、把 package.json 里的脚本名猜错、把用户自己写过的
 * 段落一把删掉。这段话里每一条禁令都对应一种真实的坏结果。
 *
 * ── 为什么不给模板 ──
 * 给了模板,模型会去填格子:没有 CI 的项目也会长出一节空的 CI。这个文件的
 * 价值全在「这个仓库特有的那几件事」上,而格子恰恰会把它们挤没。
 */
export function initPrompt(input: InitPromptInput): string {
  const agents = join(input.root, AGENTS_FILE)
  const lines = [
    `Write the project conventions file for this repository: ${agents}`,
    "",
    "That file is loaded into your system prompt at the start of every future session here, so it is the one place where what you work out about this project survives. Write it for a capable engineer who has never seen this repo.",
    "",
    input.existing
      ? "It already exists. Read it first and improve it in place: keep every line that is still true, fix the ones that are not, add what is missing. Do not delete something merely because you did not get around to checking it."
      : "It does not exist yet — you are writing it from scratch.",
    "",
    "Look before you write: the README, the build and test configuration (package.json scripts, Makefile, pyproject.toml, Cargo.toml, go.mod, CI workflows), the directory layout, and enough source to see the conventions the code actually follows rather than the ones it claims to. If instructions for other agents are lying around (CLAUDE.md, .cursorrules, .cursor/rules/, .github/copilot-instructions.md), read them and fold in what is worth keeping instead of duplicating it.",
    "",
    "Put in:",
    "- The exact commands to install, build, run, test, lint and typecheck — copied out of the configuration, not guessed. You will reach for these every session, and a wrong one costs a failed command every time.",
    "- What this project is, and the few structural facts the file tree does not already say.",
    "- The conventions a newcomer would otherwise break, especially the ones that are unusual here.",
    "- Anything sharp: a setup step that is easy to miss, something that looks broken but is not, a command that must not be run in this repo.",
    "",
    "Leave out: anything a glance at the file tree already answers, advice that would be true of any repository, and a directory listing. Length follows content — a small project deserves a short file.",
    "",
    `Two things to leave alone: the \`${ALFA_DIR}/\` folder (that one is alfa's own, not part of what you are documenting), and version control — do not commit anything.`,
  ]
  // 用户那句话放在最后:它是这几段里唯一因人而异的一条,而越靠后越容易被照做
  if (input.note && input.note.length > 0) {
    lines.push("", `The user asked you to keep this in mind while writing it: ${input.note}`)
  }
  return lines.join("\n")
}
