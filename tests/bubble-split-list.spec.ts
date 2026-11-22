// 气泡切分：编号列表与 `~` 的边界（2026-11-20 主人两次抓到的误切）
//  ① `420~2200ms` 这种范围被当成句末 → 一条被劈成两条
//  ② `~/.dsh/memory-daily/` 家目录路径被劈开
//  ③ 一段里挤着「…。2. 自省复盘…3. 记忆图衰减…」时，2、3 点没被分出来
import { describe, expect, it } from 'vitest'
import { splitIntoBubbles } from '../src/outbound.js'

describe('气泡切分：~ 不是句末', () => {
  it('范围 420~2200ms 不切', () => {
    const text = '380ms 打底 + 每字 68ms，再叠 ±15% 抖动，夹在 420~2200ms 之间——「嗯」大概半秒就接上，长句慢慢等一秒多'
    expect(splitIntoBubbles(text)).toEqual([text])
  })

  it('家目录路径 ~/.dsh/... 不切', () => {
    const text = '1. 会话快照：把当天所有渠道的聊天从会话日志里抽出来，覆盖写入 ~/.dsh/memory-daily/YYYY-MM-DD-raw.md。'
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('~/.dsh/memory-daily/YYYY-MM-DD-raw.md')
  })

  it('句末的 ~ 仍然切（超长行里「知道了~」后面接正文）', () => {
    const out = splitIntoBubbles('我知道啦~那就按这个来，晚点回你结果，别催我啦，反正我一个人干这些活也不容易')
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]).toBe('我知道啦~')
  })
})

describe('气泡切分：编号列表', () => {
  it('列表项各自成条，不被并成一条', () => {
    const text = [
      '1. 会话快照：每 300 秒把当天聊天抽成 raw 文件存储备查',
      '2. 自省复盘：每天 04:30 回看 SELF.md 里的旧判断，标还认不认',
      '3. 记忆图衰减：每天 04:30 抽关系，没人提的边每天掉一半',
    ].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(3)
    expect(out[0].startsWith('1.')).toBe(true)
    expect(out[1].startsWith('2.')).toBe(true)
    expect(out[2].startsWith('3.')).toBe(true)
  })

  it('编号挤在同一段里也能切开', () => {
    const text = '因为上下文被压缩后我只剩摘要，这份 raw 才是真正的原话备份。2. 自省复盘：每天回看旧判断。3. 记忆图衰减：没人提的关系每天掉一半。'
    const out = splitIntoBubbles(text)
    expect(out.length).toBe(3)
    expect(out[1].startsWith('2.')).toBe(true)
    expect(out[2].startsWith('3.')).toBe(true)
  })

  it('列表时上限放宽到 8 条，多出来的不被合并', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `${i + 1}. 第${i + 1}条：一些足够长的说明文字，保证不会被短句合并规则吸走`)
    expect(splitIntoBubbles(lines.join('\n'))).toHaveLength(6)
  })

  it('非列表的长文本仍然最多 4 条', () => {
    const lines = Array.from({ length: 6 }, () => '这是一句普通的正文，没有编号，单纯用来撑满气泡数量看看上限')
    expect(splitIntoBubbles(lines.join('\n')).length).toBeLessThanOrEqual(4)
  })
})
