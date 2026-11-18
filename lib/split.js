/**
 * Outbound text shaping: Markdown stripping for
 * QQ, [[qq_forward]] block parsing, and the sensitive-intent audit.
 * Ported from the Hermes onebot_utils.py split/markdown half.
 * @module dsh-onebot/split
 */
/**
 * Strip Markdown into QQ-friendly plain text. QQ does not render Markdown;
 * headings, emphasis, links, code fences, and tables are flattened. The
 * internal [[qq_forward]] markers are preserved (handled before this runs).
 * @param text - model-produced Markdown text.
 * @returns plain text for QQ.
 */
export function stripMarkdown(text) {
    let out = text
        // Code fences: keep the inner text, drop the fence lines.
        .replace(/\x60\x60\x60[^\n]*\n([\s\S]*?)\x60\x60\x60/g, (_, body) => body + '\n')
        .replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '$1')
        // Inline code: keep content, drop backticks.
        .replace(/\x60([^\x60\n]+)\x60/g, '$1')
        // Headings.
        .replace(/^#{1,6}[ \t]+/gm, '')
        // Emphasis.
        .replace(/(?<![0-9A-Za-z*])\*\*([^*\n]+?)\*\*(?![0-9A-Za-z*])/g, '$1')
        .replace(/(^|[^\p{L}\p{N}_])___([^_\n]+)___(?![\p{L}\p{N}_])/gu, '$1$2')
        .replace(/(^|[^\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, '$1$2')
        .replace(/(?<![0-9A-Za-z*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![0-9A-Za-z*])/g, '$1')
        .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1')
        // Links and images.
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '[图片]')
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')
        // Blockquote markers.
        .replace(/^[ \t]*>[ \t]?/gm, '')
        // Table rows: keep cell text separated by spaces; drop divider rows.
        .split('\n')
        .map(line => {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|') && !line.includes('\n')) {
            const cells = line.split('|').filter(c => c.trim() !== '');
            if (cells.every(c => /^:?-{2,}:?$/.test(c.trim())))
                return '';
        }
        if (line.trim().startsWith('|')) {
            return line.split('|').map(c => c.trim()).filter(c => c !== '').join(' ');
        }
        return line;
    })
        .filter(line => line !== '')
        .join('\n')
        // Horizontal rules.
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
        // Collapse 3+ blank lines.
        .replace(/\n{3,}/g, '\n\n');
    return out.trim();
}
/** The [[qq_forward]] marker regex (imported from cq.ts for single sourcing). */
import { FORWARD_BLOCK_RE } from './cq.js';
export { FORWARD_BLOCK_RE };
/**
 * Extract [[qq_forward]] blocks from reply text. The blocks are removed from
 * the returned body text; empty-name blocks default the sender name.
 * @param text - the reply text (before Markdown stripping).
 * @param defaultName - node name when the block omits one.
 * @returns body text without blocks, plus the parsed nodes.
 */
export function extractForwardBlocks(text, defaultName) {
    const nodes = [];
    const body = text.replace(FORWARD_BLOCK_RE, (_, block) => {
        const trimmed = block.trim();
        if (trimmed === '')
            return '';
        const lines = trimmed.split('\n');
        const first = lines[0].trim();
        let name = defaultName;
        let content = trimmed;
        if (first.length <= 24 && !first.includes('：') && !first.includes(':') && lines.length > 1) {
            name = first;
            content = lines.slice(1).join('\n').trim();
        }
        if (content !== '')
            nodes.push({ name, content });
        return '';
    });
    return { body, nodes };
}
// ── 气泡切分（2026-11-16 重打；0.11.0 把老 splitIntoBubbles 删了）──────────
// 主人 2026-11-07 定的规矩：正文里有换行就一行一条；没有换行且超过 30 字就
// 按句号/问号/叹号切；最多 5 条，超了相邻合并（从末尾往前合，尾巴最长）。
/** 一回合最多几个气泡。 */
export const BUBBLE_MAX = 5;
/** 单段没有换行时，超过这个字数才按句子切。 */
export const BUBBLE_SENTENCE_MIN = 30;
/**
 * Strip trailing CJK full stops from every line.
 * 2026-11-16 主人要求：聊天里句末不带「。」；问号、叹号照留。
 * @param text - outbound text.
 * @returns the same text with line-ending 「。」 removed.
 */
export function stripTrailingPeriods(text) {
    return text
        .split('\n')
        .map(line => line.replace(/[。｡]+[ \t]*$/u, ''))
        .join('\n');
}
/**
 * Split a reply body into QQ bubbles.
 * @param text - plain outbound text (after Markdown stripping).
 * @returns the bubbles, or [] when the text is blank.
 */
export function splitIntoBubbles(text) {
    // 2026-11-16 主人要的：句末的「。」一律剥掉（问号叹号照留）。
    const raw = stripTrailingPeriods(text).trim();
    if (raw === '')
        return [];
    let parts;
    if (raw.includes('\n')) {
        // 换行（单行或空行都算）→ 一行一条。
        parts = raw.split('\n').map(line => line.trim()).filter(line => line !== '');
    }
    else if (raw.length > BUBBLE_SENTENCE_MIN) {
        // 单段长文 → 按句末标点切，标点留在前一句尾巴上。
        parts = raw.split(/(?<=[。！？!?；;])/u).map(part => part.trim()).filter(part => part !== '');
    }
    else {
        return [raw];
    }
    if (parts.length <= 1)
        return [raw];
    // 超过上限：从末尾往前把相邻两条合并，保证顺序不变。
    while (parts.length > BUBBLE_MAX) {
        const n = parts.length;
        parts.splice(n - 2, 2, parts[n - 2] + parts[n - 1]);
    }
    return parts;
}
/** Sensitive-intent audit: log a WARNING when outbound text matches. */
const DEFAULT_SENSITIVE_PATTERNS = [
    /(?:rm\s+-rf|format\s+[a-z]:|diskpart|mkfs\.)/i,
    /(?:shutdown|reboot|poweroff|init\s+0)/i,
    /(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)/i,
    /(?:sk-|ghp_|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/i,
];
/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export function scanSensitive(text, patterns) {
    const list = patterns.length > 0 ? patterns : DEFAULT_SENSITIVE_PATTERNS;
    const hits = [];
    for (const p of list) {
        const re = p instanceof RegExp ? p : new RegExp(p, 'i');
        if (re.test(text))
            hits.push(String(p));
    }
    return hits;
}
