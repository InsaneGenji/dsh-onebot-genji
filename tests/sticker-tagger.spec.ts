/**
 * 表情包识别器（src/stickers.ts 的 makeStickerTagger）契约测试。
 *
 * 2026-11-19 的 no-result 事故复盘：面板点「重新识别」秒回 no-result，因为
 * makeStickerTagger 调宿主 ctx.attachments.saveImages 时只传了 { data, name }，
 * 缺 mediaType —— 宿主 AttachmentStore.validateImageBatch 会先跑
 * `limits.mediaTypes.includes(input.mediaType)`，undefined 直接被拒
 * （UNSUPPORTED_IMAGE_TYPE），tagger catch 住返回 null，retag 就记成 no-result。
 *
 * 这里锁三件事：
 *   ① saveImages 的入参必须带 mediaType，且与图片字节的真实类型一致；
 *   ② data 是字节（Buffer），不是 base64 字符串；
 *   ③ 宿主服务走 ctx.get 也取得到（插件没把这些服务写进 static inject）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeStickerTagger } from '../src/stickers.js'

/** 一张最小的合法 PNG 头（8 字节签名 + IHDR 片段），够 sniffImageMime 认出 image/png。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])

const dir = mkdtempSync(join(tmpdir(), 'onebot-tagger-'))
const pngPath = join(dir, 'sample.png')
writeFileSync(pngPath, PNG_BYTES)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface SaveImagesInput {
  data: Buffer
  mediaType?: string
  name: string
}

/** 宿主 ctx 替身：只实现 ctx.get（cordis 正规入口），不再有同名属性。 */
function fakeCtx(saved: SaveImagesInput[][], logs: string[]): unknown {
  const attachments = {
    async saveImages(inputs: SaveImagesInput[]) {
      saved.push(inputs)
      return inputs.map((input) => ({
        attachmentId: 'sha256:0'.repeat(8),
        mediaType: input.mediaType,
        width: 1,
        height: 1,
        bytes: input.data.byteLength,
        name: input.name,
      }))
    },
  }
  const llm = {
    // 宿主 LlmRuntime.prepareCall 是 async：这里返回 Promise，锁住「必须 await」这条。
    async prepareCall() {
      return {
        config: {},
        // 故意产出一个 BlockAssembler 不认的 chunk：让 tagger 走 catch 分支返回 null，
        // 只为验证附件入库那一步的入参，不依赖模型真实回包。
        async* stream() {
          yield {}
        },
      }
    },
  }
  const agentDefaultModel = {
    currentSelection() {
      return { provider: 'fake', model: 'fake' }
    },
  }
  const services: Record<string, unknown> = { attachments, llm, agentDefaultModel }
  return {
    get(key: string) {
      return services[key]
    },
  }
}

describe('makeStickerTagger：附件入库入参', () => {
  it('saveImages 收到 mediaType + 字节 Buffer（缺 mediaType 会被宿主直接拒）', async () => {
    const saved: SaveImagesInput[][] = []
    const logs: string[] = []
    const tagger = makeStickerTagger(fakeCtx(saved, logs), { log: (level, message) => logs.push(level + ':' + message) })
    await tagger(pngPath)
    expect(saved).toHaveLength(1)
    const first = saved[0]![0]!
    expect(first.mediaType).toBe('image/png')
    expect(Buffer.isBuffer(first.data)).toBe(true)
    expect(first.data.byteLength).toBe(PNG_BYTES.byteLength)
    expect(first.name).toBe('sample.png')
    // prepareCall 是 async：漏 await 时拿到的是 Promise，会报
    // 「call.stream(...) is not a function or its return value is not async iterable」。
    expect(logs.some((line) => line.includes('is not a function'))).toBe(false)
  })

  it('宿主服务只挂在 ctx.get 上也能取到（不依赖 static inject）', async () => {
    const saved: SaveImagesInput[][] = []
    const logs: string[] = []
    const tagger = makeStickerTagger(fakeCtx(saved, logs), { log: (level, message) => logs.push(level + ':' + message) })
    await tagger(pngPath)
    // 取不到服务时会 log「表情包识别跳过：宿主缺 attachments/llm/agentDefaultModel」并 return null
    expect(logs.some((line) => line.includes('宿主缺'))).toBe(false)
    expect(saved).toHaveLength(1)
  })

  it('文件不存在 / 空文件 / bmp 都直接返回 null，不碰宿主服务', async () => {
    const saved: SaveImagesInput[][] = []
    const tagger = makeStickerTagger(fakeCtx(saved, []))
    expect(await tagger(join(dir, 'missing.png'))).toBeNull()
    const emptyPath = join(dir, 'empty.png')
    writeFileSync(emptyPath, Buffer.alloc(0))
    expect(await tagger(emptyPath)).toBeNull()
    const bmpPath = join(dir, 'x.bmp')
    writeFileSync(bmpPath, Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
    expect(await tagger(bmpPath)).toBeNull()
    expect(saved).toHaveLength(0)
  })
})
