// 气泡切分（2026-11-24 主人口述的最终规则）：
//   1. 换行则分条
//   2. 遇到标点（。！？…）则分条
//   3. 列表项（1. 2、 3) / - • *）一行一条
//   4. 去掉每条末尾的「。」
//   5. 相邻气泡按上一条字数停顿 420~2200ms（bubbleGapMs，单独测）
// 旧的「35 字以内不切」「不足 6 字碎片吸附」「条数上限 3/4/8」全部取消。
import { describe, expect, it } from 'vitest'
import { splitIntoBubbles } from '../src/outbound.js'

describe('换行即分条', () => {
  it('两行就是两条，哪怕很短', () => {
    expect(splitIntoBubbles('嗯\n好')).toEqual(['嗯', '好'])
  })

  it('空行不产出空气泡', () => {
    expect(splitIntoBubbles('嗯\n\n\n好\n')).toEqual(['嗯', '好'])
  })

  it('没有标点、没有换行的长句也不硬切', () => {
    const text = '这一整句从头到尾没有任何标点所以它必须在同一条气泡里完整地发出去不许被拆开'
    expect(splitIntoBubbles(text)).toEqual([text])
  })
})

describe('句末标点即分条', () => {
  it('一句一标点，4 句出 4 条（不再有 35 字门槛，也不再有 3 条上限）', () => {
    const text = '第一句。第二句！第三句？第四句…'
    expect(splitIntoBubbles(text)).toEqual(['第一句', '第二句！', '第三句？', '第四句…'])
  })

  it('行内多个感叹号也切', () => {
    expect(splitIntoBubbles('真的！假的？')).toEqual(['真的！', '假的？'])
  })

  it('逗号、顿号、冒号、分号不是句末，不切', () => {
    const text = '先是这个，然后是那个、还有别的：总之没完；还没说完呢'
    expect(splitIntoBubbles(text)).toEqual([text])
  })

  it('单独一个标点不产气泡，并到上一条', () => {
    expect(splitIntoBubbles('真的假的\n！')).toEqual(['真的假的！'])
  })

  it('`~` 不再当句末（范围与家目录路径都不切）', () => {
    const text = '夹在 420~2200ms 之间，路径是 ~/.dsh/memory-daily/x.md 这样'
    expect(splitIntoBubbles(text)).toEqual([text])
  })
})

describe('列表项一行一条', () => {
  it('编号列表各自成条', () => {
    const text = ['1. 会话快照：每 300 秒抽一次', '2. 自省复盘：回看旧判断', '3. 记忆图衰减：没人提就掉'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(3)
    expect(out[0].startsWith('1.')).toBe(true)
    expect(out[2].startsWith('3.')).toBe(true)
  })

  it('编号挤在同一段里也能切开', () => {
    const text = '因为上下文被压缩后我只剩摘要。2. 自省复盘：每天回看旧判断。3. 记忆图衰减：没人提的关系每天掉一半。'
    const out = splitIntoBubbles(text)
    expect(out.length).toBe(3)
    expect(out[1].startsWith('2.')).toBe(true)
    expect(out[2].startsWith('3.')).toBe(true)
  })

  it('「- 」「• 」「* 」开头也算列表项', () => {
    const text = ['开头', '- 第一条足够长的说明文字', '• 第二条足够长的说明文字', '* 第三条足够长的说明文字'].join('\n')
    expect(splitIntoBubbles(text)).toHaveLength(4)
  })

  it('带列表项的整段不封顶，7 行就出 7 条', () => {
    const text = [
      '判据已经写进两个地方了',
      'src/prompt.ts 起原来只有一行，现在拆成四条：',
      '1. 正常聊天不调工具，写正文',
      '2. 唯一合格用法是要等几十秒的活',
      '3. 以下情况一律写正文',
      '4. 判据一句话：要等才算长活',
      '两处都只改文字，没加代码闸',
    ].join('\n')
    expect(splitIntoBubbles(text)).toHaveLength(7)
  })

  it('10 个编号就出 10 条（不封顶）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}. 第${i + 1}条：一些足够长的说明文字`)
    expect(splitIntoBubbles(lines.join('\n'))).toHaveLength(10)
  })
})

describe('句末句号剥掉', () => {
  it('每条末尾的「。」都去掉，问号叹号不动', () => {
    expect(splitIntoBubbles('好的，我知道了。\n真的吗？\n太棒了！')).toEqual(['好的，我知道了', '真的吗？', '太棒了！'])
  })
})
