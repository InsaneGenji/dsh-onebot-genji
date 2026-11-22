/**
 * 主动搭话的情境线索（2026-11-21 主人裁决）。
 *
 * 背景：08:28 那轮主动搭话问「电脑关了没」，可主人昨晚 18:44 就说过要关机、
 * 早上八点能跑本身就说明又是开机状态——模型当时手里没有任何情境事实。
 * 修法不是加「别问关了没」这种 if-else，而是把「现在几点 / 机器刚开机多久」
 * 当线索喂进提示词，让模型自己判断。
 */
import { describe, expect, it } from 'vitest'
import { clockOf, situationLines } from '../src/proactive.js'

describe('主动搭话：情境线索', () => {
  it('clockOf 补零到 HH:MM', () => {
    expect(clockOf(new Date(2026, 10, 21, 8, 5))).toBe('08:05')
    expect(clockOf(new Date(2026, 10, 21, 23, 59))).toBe('23:59')
  })

  it('刚开机：说清楚是几分钟前才开机、昨晚关过', () => {
    const lines = situationLines(new Date(2026, 10, 21, 8, 30), 45)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('08:30')
    expect(lines[0]).toContain('45 分钟前才开机')
    expect(lines[0]).toContain('昨晚关过')
  })

  it('开了一天：只说开了几小时，不提关机', () => {
    const lines = situationLines(new Date(2026, 10, 21, 23, 10), 600)
    expect(lines[0]).toContain('23:10')
    expect(lines[0]).toContain('10 小时')
    expect(lines[0]).not.toContain('关过')
  })

  it('开了好几天：按天算', () => {
    expect(situationLines(new Date(2026, 10, 21, 12, 0), 60 * 24 * 3)[0]).toContain('3 天')
  })

  it('读不到开机时长（0 / NaN）：只给时间，不编', () => {
    for (const bad of [0, Number.NaN]) {
      const lines = situationLines(new Date(2026, 10, 21, 9, 0), bad)
      expect(lines[0]).toContain('09:00')
      expect(lines[0]).not.toContain('开机')
    }
  })

  it('只给事实，不写「该不该问」的规矩', () => {
    const text = situationLines(new Date(2026, 10, 21, 8, 30), 45).join('\n')
    expect(text).not.toContain('不要问')
    expect(text).not.toContain('别问')
  })
})
