/**
 * 表情包库索引自愈（src/stickers.ts 的 StickerStore.pruneMissing）契约测试。
 *
 * 2026-11-19 主人反馈：未审核里出现三张「裂图」——索引里登记着 1769e1ad072d /
 * 6d9469e2e048 / 3c40af4680cb，磁盘上却没有对应文件，面板读图一直失败只剩「…」。
 *
 * 这里锁两件事：
 *   ① 文件不在的条目会被摘掉，并把索引写回磁盘（重启后不会再冒出来）；
 *   ② 索引本来就干净时返回空数组，不动任何文件。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { StickerStore } from '../src/stickers.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

/** 一个 PNG 头，够 sniffImageMime 认得出来（pruneMissing 只看文件在不在，不看内容）。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

function seededStore(): { root: string, store: StickerStore } {
  const root = mkdtempSync(join(tmpdir(), 'onebot-store-'))
  roots.push(root)
  const seed = new StickerStore({ root })
  mkdirSync(seed.approvedDir, { recursive: true })
  mkdirSync(seed.pendingDir, { recursive: true })
  // alive.png 真写出来；ghost.png 只在索引里登记，磁盘上没有。
  writeFileSync(join(seed.approvedDir, 'alive.png'), PNG_BYTES)
  writeFileSync(join(seed.indexFile), JSON.stringify({
    version: 2,
    items: {
      alive111: { hash: 'alive111', file: 'alive.png', approved: true, tags: [], description: '', bytes: PNG_BYTES.length, addedAt: 1 },
      ghost222: { hash: 'ghost222', file: 'ghost.png', approved: true, tags: [], description: '', bytes: 4, addedAt: 2 },
    },
    deleted: [],
  }, null, 2))
  return { root, store: new StickerStore({ root }) }
}

describe('StickerStore.pruneMissing', () => {
  it('摘掉文件已丢失的条目，并把索引写回磁盘', () => {
    const { root, store } = seededStore()
    expect(store.list().map((item) => item.hash).sort()).toEqual(['alive111', 'ghost222'])

    const gone = store.pruneMissing()
    expect(gone).toEqual(['ghost222'])
    expect(store.list().map((item) => item.hash)).toEqual(['alive111'])

    const onDisk = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as { items: Record<string, unknown> }
    expect(Object.keys(onDisk.items)).toEqual(['alive111'])
    expect(existsSync(join(root, '已审核', 'alive.png'))).toBe(true)
  })

  it('索引干净时返回空数组，不写盘', () => {
    const { root, store } = seededStore()
    store.pruneMissing()
    const before = readFileSync(join(root, 'index.json'), 'utf8')
    const again = store.pruneMissing()
    expect(again).toEqual([])
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(before)
  })

  /**
   * 2026-11-19 事故回归：真实库 188 条一次全被判「文件丢失」，索引被清空，图片其实还在。
   * 一次摘掉一半以上（且不少于 10 条）时按「库目录整体读不到」处理，索引必须原样留着。
   */
  it('大半条目一起读不到时按目录整体不可用处理，不摘索引', () => {
    const root = mkdtempSync(join(tmpdir(), 'onebot-store-floor-'))
    roots.push(root)
    const seed = new StickerStore({ root })
    const items: Record<string, unknown> = {}
    for (let index = 0; index < 12; index += 1) {
      const hash = `miss${index}`
      items[hash] = { hash, file: `${hash}.png`, approved: true, tags: [], description: '', bytes: 4, addedAt: index }
    }
    writeFileSync(seed.indexFile, JSON.stringify({ version: 2, items, deleted: [] }, null, 2))
    const store = new StickerStore({ root })
    expect(store.list()).toHaveLength(12)

    expect(store.pruneMissing()).toEqual([])
    expect(store.list()).toHaveLength(12)
    const onDisk = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as { items: Record<string, unknown> }
    expect(Object.keys(onDisk.items)).toHaveLength(12)
  })
})

/** 和 PNG_BYTES 不同内容，hash 才会不一样。 */
const OTHER_BYTES = Buffer.concat([PNG_BYTES, Buffer.from([0x01])])

describe('StickerStore 墓碑（删过的图别再收回来）', () => {
  /**
   * 2026-11-19 主人报的 bug 上下文：他手动删掉几张，后来想把其中一张「新增」回来，
   * 面板点了五次都 ok 但条数一直 188——因为 remove() 把 hash 写进了 index.deleted，
   * addBuffer 见到墓碑直接 { added: false, reason: 'deleted' }。
   * 规矩：自动收集照旧受墓碑约束，面板手动新增（force）要把墓碑撤掉再入库。
   */
  it('自动收集受墓碑约束：删过的图不会再被收回来', () => {
    const { store } = seededStore()
    const first = store.addBuffer(OTHER_BYTES, 'a.png')
    expect(first.added).toBe(true)
    const hash = first.item?.hash ?? ''
    expect(hash).not.toBe('')
    store.remove(hash)

    expect(store.addBuffer(OTHER_BYTES, 'a.png')).toEqual({ added: false, reason: 'deleted' })
    expect(store.list().map((item) => item.hash)).not.toContain(hash)
  })

  it('手动新增（force）撤掉墓碑并入库到未审核', () => {
    const { root, store } = seededStore()
    const first = store.addBuffer(OTHER_BYTES, 'a.png')
    expect(first.added).toBe(true)
    const hash = first.item?.hash ?? ''
    store.remove(hash)

    const again = store.addBuffer(OTHER_BYTES, 'a.png', { force: true })
    expect(again.added).toBe(true)
    expect(again.item?.hash).toBe(hash)
    const view = store.list().find((item) => item.hash === hash)
    expect(view).toBeTruthy()
    expect(view?.approved).toBe(false)
    expect(existsSync(join(store.pendingDir, again.item?.file ?? ''))).toBe(true)

    const onDisk = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as { deleted?: string[] }
    expect(onDisk.deleted ?? []).not.toContain(hash)
  })
})
