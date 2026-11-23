import { describe, expect, it } from 'vitest'

import { extractStickerTags, pickStickerByTag, STICKER_TAG_RE } from '../src/sticker-tag.js'

describe('正文表情包标签（2026-11-23 主人批准的最小版）', () => {
  it('摘掉中文标签并拿到关键词', () => {
    const r = extractStickerTags('今天真是够了 <表情:无语>')
    expect(r.keys).toEqual(['无语'])
    expect(r.text).toBe('今天真是够了')
  })

  it('也认 <sticker:> 与 <表情包:> 两种拼写，中文冒号同样吃', () => {
    expect(extractStickerTags('a<sticker:得意>b').keys).toEqual(['得意'])
    expect(extractStickerTags('a<表情包：得意>b').keys).toEqual(['得意'])
    expect(extractStickerTags('a< 表情 : 得意 >b').keys).toEqual(['得意'])
  })

  it('多个标签按出现顺序去重，正文里其它内容不动', () => {
    const r = extractStickerTags('第一句<表情:无语>\n第二句<表情:得意>\n第三句<表情:无语>')
    expect(r.keys).toEqual(['无语', '得意'])
    expect(r.text).toBe('第一句\n第二句\n第三句')
  })

  it('反引号里的标签是说明文字，原样保留', () => {
    const r = extractStickerTags('写法是 `<表情:得意>` 这样')
    expect(r.keys).toEqual([])
    expect(r.text).toBe('写法是 `<表情:得意>` 这样')
  })

  it('半截标签（没收尾）不动，别把正文啃掉', () => {
    expect(extractStickerTags('这里写 <表情:得意').text).toBe('这里写 <表情:得意')
    expect(extractStickerTags('a < b 这种尖括号照常').text).toBe('a < b 这种尖括号照常')
  })

  it('没有标签时是零成本的直通（不 trim、不改空白）', () => {
    const raw = '  前后都有空格  '
    expect(extractStickerTags(raw)).toEqual({ text: raw, keys: [] })
  })

  it('标签独占一行时不会在正文里留一堆空行', () => {
    const r = extractStickerTags('说话\n<表情:得意>')
    expect(r.text).toBe('说话')
    expect(r.keys).toEqual(['得意'])
  })
})

describe('pickStickerByTag 打分口径', () => {
  const items = [
    { file: 'exact.png', tags: ['得意'], description: '', approved: true, exists: true },
    { file: 'partial.png', tags: ['超得意'], description: '', approved: true, exists: true },
    { file: 'desc.png', tags: [], description: '蓝发女仆得意吐舌', approved: true, exists: true },
    { file: 'pending.png', tags: ['得意'], description: '', approved: false, exists: true },
    { file: 'gone.png', tags: ['得意'], description: '', approved: true, exists: false },
  ]
  const pathOf = (f: string) => 'D:\\s\\' + f

  it('标签全等的优先，未审核与磁盘缺失的不参与', () => {
    expect(pickStickerByTag(items, '得意', pathOf)).toBe('D:\\s\\exact.png')
  })

  it('没有全等就退到标签包含，再退到描述包含', () => {
    const onlyPartial = items.filter(i => i.file === 'partial.png' || i.file === 'desc.png')
    expect(pickStickerByTag(onlyPartial, '得意', pathOf)).toBe('D:\\s\\partial.png')
    expect(pickStickerByTag([items[2]], '得意', pathOf)).toBe('D:\\s\\desc.png')
  })

  it('匹配不上返回 null（等于没写，不报错）', () => {
    expect(pickStickerByTag(items, '不存在的词', pathOf)).toBe(null)
    expect(pickStickerByTag(items, '   ', pathOf)).toBe(null)
    expect(pickStickerByTag([], '得意', pathOf)).toBe(null)
  })

  it('大小写不敏感，标签里带空格的也算', () => {
    const list = [{ file: 'x.png', tags: [' Happy '], description: '', approved: true, exists: true }]
    expect(pickStickerByTag(list, 'happy', pathOf)).toBe('D:\\s\\x.png')
  })
})

describe('STICKER_TAG_RE 长度上限', () => {
  it('超过 40 字的关键词不当标签（防止把整段正文吞了）', () => {
    const long = '<表情:' + 'x'.repeat(60) + '>'
    expect(STICKER_TAG_RE.test(long)).toBe(false)
    STICKER_TAG_RE.lastIndex = 0
    expect(extractStickerTags(long).keys).toEqual([])
  })
})
