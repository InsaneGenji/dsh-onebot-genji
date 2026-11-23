/**
 * 正文表情包标签（2026-11-23 主人批准的最小版）：
 * 借鉴 aurabot 的 `<sticker:标签>` 协议，但只借「用标签代替挑文件」这一点。
 *
 * 模型在正文里写 `<表情:得意>`（也认 `<sticker:得意>` / `<表情包:得意>`），
 * 出站时把标签摘掉，按关键词去「已审核」库里找一张最贴的图，作为独立消息
 * 发出去；匹配不上就当作没写——**绝不报错、绝不把标签原样发到 QQ**。
 *
 * 为什么不整段照搬 aurabot：它把 `|||` 分气泡、`<voice>`、`<reply:`、`[沉默]`
 * 全塞进正文，全靠正则切。我们已经有 splitIntoBubbles、掷骰语音条、[[reply:]]
 * 和 [[不回]]，再叠一层只会互相打架；真正省事的只有表情包这一条。
 * @module dsh-onebot/sticker-tag
 */

/** 正文里的表情包标签：`<表情:关键词>` / `<sticker:关键词>` / `<表情包:关键词>`。
 *  关键词里不认尖括号和换行，长度给个上限免得太贪。 */
export const STICKER_TAG_RE = /<[ \t]*(?:表情包|表情|sticker)[ \t]*[:：][ \t]*([^<>\r\n]{1,40}?)[ \t]*>/gi

/** 摘标签的结果：`text` 是去掉标签后的正文，`keys` 是按出现顺序去重后的关键词。 */
export interface StickerTagParse {
  text: string
  keys: string[]
}

/**
 * 从正文里摘掉全部表情包标签。
 *
 * 只认完整成对形态 `<…:…>`；写成 `<表情:` 没收尾、或者正文里讨论这个语法
 * 本身（带了反引号）时都不动——宁可少发一张图，也不要把半截标签发出去。
 * 反引号包裹的整段（`` `<表情:得意>` ``）保留原样，那是说明文字不是指令。
 */
export function extractStickerTags(raw: string): StickerTagParse {
  const body = String(raw ?? '')
  if (body === '' || !body.includes('<'))
    return { text: body, keys: [] }
  const keys: string[] = []
  const text = body.replace(STICKER_TAG_RE, (match: string, key: string, offset: number) => {
    // 反引号内的原样保留：模型在解释这个语法时不该被吃掉。
    const before = body.slice(0, offset)
    const ticks = (before.match(/`/g) ?? []).length
    if (ticks % 2 === 1)
      return match
    const trimmed = key.trim()
    if (trimmed === '')
      return ''
    if (!keys.includes(trimmed))
      keys.push(trimmed)
    return ''
  })
  if (keys.length === 0)
    return { text: body, keys: [] }
  // 摘完标签常留下「一句话」和空行，收一下边角，但别动正文里的换行结构。
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), keys }
}

/** 匹配用的最小条目形状——只取 StickerStore.list() 里用得到的字段。 */
export interface StickerCandidate {
  file: string
  tags: string[]
  description: string
  approved: boolean
  exists: boolean
}

/**
 * 按关键词在候选里挑一张。
 *
 * 打分口径（从高到低）：标签完全等于关键词 > 标签包含关键词 > 描述包含关键词。
 * 同分时按传入顺序（调用方传的是 addedAt 倒序，即新的优先）。只看 approved
 * 且 exists 的条目——「未审核」不进聊天，磁盘上没了的也点不出来。
 *
 * @returns 命中条目的绝对路径，或 null（匹配不上就是没写）。
 */
export function pickStickerByTag(
  candidates: readonly StickerCandidate[],
  key: string,
  pathOf: (file: string) => string,
): string | null {
  const target = String(key ?? '').trim().toLowerCase()
  if (target === '')
    return null
  let bestScore = 0
  let bestFile: string | null = null
  for (const item of candidates) {
    if (!item.approved || !item.exists || item.file === '')
      continue
    let score = 0
    for (const tag of item.tags) {
      const t = String(tag ?? '').trim().toLowerCase()
      if (t === '')
        continue
      if (t === target)
        score = Math.max(score, 3)
      else if (t.includes(target) || target.includes(t))
        score = Math.max(score, 2)
    }
    const desc = String(item.description ?? '').toLowerCase()
    if (desc !== '' && desc.includes(target))
      score = Math.max(score, 1)
    if (score > bestScore) {
      bestScore = score
      bestFile = item.file
    }
  }
  return bestFile === null ? null : pathOf(bestFile)
}
