/**
 * 句末句号（2026-11-22 主人要求：聊天里句末别挂「。」）。
 * 只剥气泡末尾的「。」，问号、叹号、英文点号、省略号都不动。
 */
import { describe, expect, it } from 'vitest'
import { splitIntoBubbles, stripTrailingPeriod } from '../src/outbound.js'

describe('stripTrailingPeriod', () => {
  it('末尾一个中文句号 → 剥掉', () => {
    expect(stripTrailingPeriod('好的，我知道了。')).toBe('好的，我知道了')
  })

  it('问号、叹号、省略号一律不碰', () => {
    expect(stripTrailingPeriod('真的假的！')).toBe('真的假的！')
    expect(stripTrailingPeriod('这是啥？')).toBe('这是啥？')
    expect(stripTrailingPeriod('那就这样吧…')).toBe('那就这样吧…')
  })

  it('英文点号不碰', () => {
    expect(stripTrailingPeriod('version 3.')).toBe('version 3.')
  })

  it('中间的句号保留', () => {
    expect(stripTrailingPeriod('先这样。回头再说。')).toBe('先这样。回头再说')
  })

  it('空串 / 纯空白不报错', () => {
    expect(stripTrailingPeriod('')).toBe('')
    expect(stripTrailingPeriod('   ')).toBe('   ')
  })
})

describe('splitIntoBubbles 气泡末尾不带句号', () => {
  it('单条正文末尾的句号被剥掉', () => {
    expect(splitIntoBubbles('好的，我知道了。')).toEqual(['好的，我知道了'])
  })

  it('多条气泡每条都剥', () => {
    expect(splitIntoBubbles('好的，我知道了。\n真的假的。')).toEqual(['好的，我知道了', '真的假的'])
  })

  it('列表行并成一条时也逐行剥（2026-11-24 第八版）', () => {
    expect(splitIntoBubbles('1. 第一条。\n2. 第二条。')).toEqual(['1. 第一条\n2. 第二条'])
  })

  it('叹号结尾原样保留', () => {
    expect(splitIntoBubbles('真的假的！')).toEqual(['真的假的！'])
  })
})
