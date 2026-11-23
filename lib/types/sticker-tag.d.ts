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
export declare const STICKER_TAG_RE: RegExp;
/** 摘标签的结果：`text` 是去掉标签后的正文，`keys` 是按出现顺序去重后的关键词。 */
export interface StickerTagParse {
    text: string;
    keys: string[];
}
/**
 * 从正文里摘掉全部表情包标签。
 *
 * 只认完整成对形态 `<…:…>`；写成 `<表情:` 没收尾、或者正文里讨论这个语法
 * 本身（带了反引号）时都不动——宁可少发一张图，也不要把半截标签发出去。
 * 反引号包裹的整段（`` `<表情:得意>` ``）保留原样，那是说明文字不是指令。
 */
export declare function extractStickerTags(raw: string): StickerTagParse;
/** 匹配用的最小条目形状——只取 StickerStore.list() 里用得到的字段。 */
export interface StickerCandidate {
    file: string;
    tags: string[];
    description: string;
    approved: boolean;
    exists: boolean;
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
export declare function pickStickerByTag(candidates: readonly StickerCandidate[], key: string, pathOf: (file: string) => string): string | null;
