import { describe, expect, it } from 'vitest'
import {
  BUBBLE_GAP_BASE_MS,
  BUBBLE_GAP_MAX_MS,
  BUBBLE_GAP_MIN_MS,
  BUBBLE_GAP_PER_CHAR_MS,
  bubbleGapMs,
} from '../src/outbound.js'

/** 2026-11-20 主人：「停顿按照每条的字数来吧 不要固定 1500ms」。 */
describe('bubbleGapMs：跟字数走的拟人停顿', () => {
  it('短句只等一点点，不会固定成 1500ms', () => {
    const short = bubbleGapMs('嗯', () => 0.5)
    expect(short).toBeLessThan(600)
  })

  it('字数越多等得越久（同抖动下单调）', () => {
    const mid = () => 0.5
    const a = bubbleGapMs('好', mid)
    const b = bubbleGapMs('这句稍微长一点，够你眼睛扫过来了', mid)
    const c = bubbleGapMs('这一句更长一些，写满一整个气泡，读起来得花上两秒左右的时间', mid)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('公式对得上：base + 字数 * per_char，再叠抖动', () => {
    const text = '一二三四五六七八九十'
    expect(bubbleGapMs(text, () => 0.5)).toBe(BUBBLE_GAP_BASE_MS + [...text].length * BUBBLE_GAP_PER_CHAR_MS)
  })

  it('抖动在 ±15% 之间，且始终夹在上下限内', () => {
    const text = '这句用来测抖动'
    const mid = bubbleGapMs(text, () => 0.5)
    const low = bubbleGapMs(text, () => 0)
    const high = bubbleGapMs(text, () => 0.999999)
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
    expect(low).toBeGreaterThanOrEqual(BUBBLE_GAP_MIN_MS)
    expect(high).toBeLessThanOrEqual(BUBBLE_GAP_MAX_MS)
    // 极端值也不会爆掉
    expect(bubbleGapMs('', () => 0)).toBe(BUBBLE_GAP_MIN_MS)
    expect(bubbleGapMs('很长'.repeat(200), () => 0.999999)).toBe(BUBBLE_GAP_MAX_MS)
  })

  it('空串/异常抖动都退回安全值', () => {
    expect(bubbleGapMs()).toBeGreaterThanOrEqual(BUBBLE_GAP_MIN_MS)
    expect(bubbleGapMs('测试', () => Number.NaN)).toBe(BUBBLE_GAP_BASE_MS + 2 * BUBBLE_GAP_PER_CHAR_MS)
  })
})
