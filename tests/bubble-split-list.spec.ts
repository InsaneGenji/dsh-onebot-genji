// 气泡切分（2026-11-24 主人口述的最终规则，第八版）：
//   1. 换行则分条——**列表项行例外**
//   2. 列表项（1. 2、 3) / - • * 开头）前面有换行的，**不要分条**：并进上一条气泡，
//      内部保留那个换行
//   3. 去掉每条末尾的「。」
//   4. 相邻气泡按上一条字数停顿 420~2200ms（bubbleGapMs，单独测）
// 演进：删掉了「遇到标点就分条」（一句话两三个句号就炸成三条像刷屏）；更早的
// 「35 字以内不切」「不足 6 字碎片吸附」「条数上限 3/4/8」也全部取消；
// 第七版先做「行内挤着的编号补换行但仍是一条」，第八版把同一意图推广到
// 本来就用换行排好的列表——四行的「摘要 + 三个编号」也是一条，不是四条。
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

describe('句末标点不再切分（2026-11-24 主人删掉这条规则）', () => {
  it('一句话里有多个句号，仍然是一条', () => {
    const text = '第一句。第二句！第三句？第四句…'
    expect(splitIntoBubbles(text)).toEqual([text])
  })

  it('感叹号问号挤在一起也不切，只在末尾剥「。」', () => {
    expect(splitIntoBubbles('真的！假的？好吧。')).toEqual(['真的！假的？好吧'])
  })

  it('逗号、顿号、冒号、分号本来就不切', () => {
    const text = '先是这个，然后是那个、还有别的：总之没完；还没说完呢'
    expect(splitIntoBubbles(text)).toEqual([text])
  })

  it('单独一行一个标点，就发那一个标点', () => {
    expect(splitIntoBubbles('真的假的\n！')).toEqual(['真的假的', '！'])
  })

  it('`~` 不当句末（范围与家目录路径都不切）', () => {
    const text = '夹在 420~2200ms 之间，路径是 ~/.dsh/memory-daily/x.md 这样'
    expect(splitIntoBubbles(text)).toEqual([text])
  })
})

describe('列表项前面有换行就不分条，并进上一条（2026-11-24 第八版）', () => {
  it('摘要 + 三行编号 = 一条气泡，内部四行', () => {
    const text = [
      '因为只剩摘要',
      '1. 自省复盘：每天回看旧判断',
      '2. 记忆图衰减：没人提的关系每天掉一半',
      '3. 会话快照：每 300 秒抽一次',
    ].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(
      '因为只剩摘要\n1. 自省复盘：每天回看旧判断\n2. 记忆图衰减：没人提的关系每天掉一半\n3. 会话快照：每 300 秒抽一次',
    )
  })

  it('「- 」「• 」「* 」开头的行同样并进上一条', () => {
    const text = ['开头', '- 第一条足够长的说明文字', '• 第二条足够长的说明文字', '* 第三条足够长的说明文字'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0].split('\n')).toHaveLength(4)
  })

  it('中文「一、二、三、」也算列表，并进上一条（2026-11-24 主人补）', () => {
    const text = ['我列了四条思路', '一、时间兜底', '二、按工具批次报', '三、让模型自己决定', '四、混合'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0].split('\n')).toHaveLength(5)
    expect(out[0]).toContain('\n一、时间兜底')
    expect(out[0]).toContain('\n四、混合')
  })

  it('行内挤着的中文编号也补换行（「…思路一、…二、…」）', () => {
    const text = '我列了几条方案 一、时间兜底 二、按批次报 三、自己决定'
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0].split('\n')).toHaveLength(4)
  })

  it('列表后面再跟普通句子，那句自己成一条', () => {
    const text = ['开头一句', '1. 第一条', '2. 第二条', '结尾这句另起一条'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe('开头一句\n1. 第一条\n2. 第二条')
    expect(out[1]).toBe('结尾这句另起一条')
  })

  it('列表第一行就是开头时，它自己起一条，后面的并进来', () => {
    const text = ['1. 会话快照：每 300 秒抽一次', '2. 自省复盘：回看旧判断', '3. 记忆图衰减：没人提就掉'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0].split('\n')).toHaveLength(3)
  })

  it('行内挤着的编号补换行，仍是一条（第七版规则保留）', () => {
    const text = '因为只剩摘要。1. 自省复盘：每天回看旧判断。2. 记忆图衰减：没人提的关系每天掉一半。3. 会话快照：每 300 秒抽一次。'
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(
      '因为只剩摘要\n1. 自省复盘：每天回看旧判断\n2. 记忆图衰减：没人提的关系每天掉一半\n3. 会话快照：每 300 秒抽一次',
    )
  })

  it('10 行编号也只出一条，不封顶也不拆分', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}. 第${i + 1}条：一些足够长的说明文字`)
    const out = splitIntoBubbles(lines.join('\n'))
    expect(out).toHaveLength(1)
    expect(out[0].split('\n')).toHaveLength(10)
  })
})

describe('句末句号剥掉', () => {
  it('每条末尾的「。」都去掉，问号叹号不动', () => {
    expect(splitIntoBubbles('好的，我知道了。\n真的吗？\n太棒了！')).toEqual(['好的，我知道了', '真的吗？', '太棒了！'])
  })

  it('并进气泡的列表行也各自剥掉末尾「。」', () => {
    const text = ['开头。', '1. 第一条。', '2. 第二条。'].join('\n')
    const out = splitIntoBubbles(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe('开头\n1. 第一条\n2. 第二条')
  })
})
