/**
 * 补话不许凭空编（2026-11-21 教训）。
 *
 * 事情经过：早上那句补话「对了，萝卜田那笔账我可记着呢，别以为"行"一声就完了」，
 * 主人回头问「萝卜田是啥啊」——那玩意儿根本不存在。根因是线索里主人上一句只是
 * 「[图片]」，模型手里没有任何可接的文字，就自己造了一个话题。
 */
import { describe, expect, it } from 'vitest'
import { isPlaceholderOnly } from '../src/proactive.js'

describe('isPlaceholderOnly', () => {
  it('纯占位符算没有内容', () => {
    for (const s of ['[图片]', '[语音]', '[视频]', '[表情包]', '[文件]', '[图片] [语音]', '[CQ:image,file=a.jpg]', '']) {
      expect(isPlaceholderOnly(s), s).toBe(true)
    }
  })

  it('有文字就不算占位符', () => {
    for (const s of ['嗯嗯', '[图片] 你看这个', '萝卜田是啥啊', '早上好']) {
      expect(isPlaceholderOnly(s), s).toBe(false)
    }
  })

  it('只有标点空白也算没内容', () => {
    expect(isPlaceholderOnly('  ')).toBe(true)
    expect(isPlaceholderOnly('……')).toBe(true)
  })
})
