/**
 * 步数上限。
 *
 * 这不是「防止跑飞」的安全阀 —— 权限层才是。它防的是**沉默的死循环**:
 * 模型反复 edit 同一个文件、反复 grep 同一个词,每一步都合法,加起来是烧钱。
 *
 * 到顶时的做法很重要:**不是直接掐断**,而是最后再给一轮机会,把工具关掉
 * (toolChoice: 'none')并注入下面这段话,让它用纯文本交代进度。
 * 直接掐断的话,用户看到的是一个半截的会话,不知道模型做到哪了、还差什么。
 */
export const MAX_STEPS = 100

export const MAX_STEPS_PROMPT = [
  "<system-reminder>",
  `You have reached the maximum number of tool-use steps (${MAX_STEPS}) for this turn.`,
  "No further tool calls are possible. Respond now with text only:",
  "- What you accomplished",
  "- What is left unfinished, and precisely where you stopped",
  "- The exact next step you would take, so the user can continue by simply saying so",
  "Do not apologize at length. Be specific and factual.",
  "</system-reminder>",
].join("\n")
