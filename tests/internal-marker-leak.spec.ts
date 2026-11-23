/**
 * 2026-11-23 主人要求：出站剥掉「内部调度标记」。
 *
 * 症状：模型把入站占位、工具回执抬头、入站时间戳当正文抄回 QQ，用户看到
 *   [14:15] [图片:C:\Users\...\media_xxx.jpg]
 *   Attached image(s) from tool result:
 *   以及一个只有「[14:21]」的空气泡。
 *
 * 清洗哲学与 #26/#46 一致：只认固定前缀/带路径的受限形态，普通正文里出现的
 * 同类字眼不动。
 * @module dsh-onebot/tests/internal-marker-leak
 */
import { describe, expect, it } from 'vitest'

import { stripBoundaryLeakage } from '../src/outbound.js'

describe('2026-11-23: 内部调度标记出站清洗', () => {
  it('整行只有 [图片:路径] 的丢掉（含前置时间戳）', () => {
    const leak = '[14:15] [图片:C:\\Users\\InsaneGenji\\.dsh\\media\\onebot\\media_1795.jpg]'
    expect(stripBoundaryLeakage(leak)).toBe('')
    expect(stripBoundaryLeakage('[图片:/tmp/a.png]')).toBe('')
    expect(stripBoundaryLeakage('[表情包:D:/x/b.gif]')).toBe('')
  })

  it('句中夹的 [图片:路径] 只删标记、保留句子', () => {
    const leak = '你说的那张 [图片:C:\\a\\b.jpg] 我看了，是我们聊天的截图'
    expect(stripBoundaryLeakage(leak)).toBe('你说的那张  我看了，是我们聊天的截图')
  })

  it('工具回执抬头整行丢掉', () => {
    const leak = 'Attached image(s) from tool result:\n图没下来'
    expect(stripBoundaryLeakage(leak)).toBe('图没下来')
    expect(stripBoundaryLeakage('Attached image from tool result:')).toBe('')
  })

  it('行首 [HH:MM] 前缀删掉；只剩时间戳的行变空被丢弃', () => {
    expect(stripBoundaryLeakage('[14:21]')).toBe('')
    expect(stripBoundaryLeakage('[14:21]\n[14:22]')).toBe('')
    expect(stripBoundaryLeakage('[14:21] 重启解决不了这事')).toBe('重启解决不了这事')
    expect(stripBoundaryLeakage('[09:05 昵称(10001)·管理员] 早')).toBe('早')
  })

  it('正文里正常聊到的字眼不误伤', () => {
    expect(stripBoundaryLeakage('我给你发张图看下')).toBe('我给你发张图看下')
    expect(stripBoundaryLeakage('时间是 14:21，别迟到')).toBe('时间是 14:21，别迟到')
    expect(stripBoundaryLeakage('这个 [图片] 标记是插件加的')).toBe('这个 [图片] 标记是插件加的')
    // 没有路径的裸 [图片] 占位不算泄漏（用户也可能是这么写的）
    expect(stripBoundaryLeakage('[图片]')).toBe('[图片]')
  })
})
