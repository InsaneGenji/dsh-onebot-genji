/**
 * Voice transcription is waited on before dispatch (2026-11-19):
 * a voice message must produce exactly ONE turn. The transcript is inlined
 * into the body when it arrives within VOICE_TRANSCRIBE_WAIT_MS; a timeout or
 * failure falls back to the `[语音]` placeholder and the late result is
 * dropped — it must never steer into a second turn.
 * @module dsh-onebot/tests/stt-single-turn
 */
import { describe, expect, it, vi } from 'vitest'

import { InboundPipeline, VOICE_TRANSCRIBE_WAIT_MS } from '../src/inbound.js'
import type { InboundContext } from '../src/inbound.js'
import type { ChatId } from '../src/chat.js'

import { makeHarness } from './helpers/bridge-harness.js'

/** Minimal pipeline context for direct resolveMediaRef tests (voice path). */
function makePipelineCtx(transcribe: (path: string) => Promise<string>, steers: Array<{ chatId: ChatId; text: string }>, logs: string[]): InboundContext {
  return {
    call: vi.fn(async () => undefined),
    selfId: () => '10002',
    policy: { dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [], adminUsers: [], allowAllUsers: false, requireMention: true },
    getChat: () => undefined,
    getSettings: () => ({}),
    sweepIdleChats: async () => undefined,
    media: { resolve: async () => ({ kind: 'voice', path: '/tmp/voice-1.mp3' }) } as never,
    transcriber: { enabled: true, transcribe } as never,
    steerTranscript: (chatId, text) => { steers.push({ chatId, text }) },
    tryHandleCommand: async () => false,
    dispatchFollowup: async () => undefined,
    sendToChat: async () => [],
    log: (level, message) => { logs.push(level + ': ' + message) },
    config: { botQQ: '10002', ignoreSelf: false, requireMention: true, rateLimitPerMinute: 0, restrictedMemberPrefix: false, maxInboundFileBytes: 0 },
  } as never
}

describe('voice transcription before dispatch', () => {
  it('inlines the transcript and never steers (one turn per voice message)', async () => {
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const transcribe = vi.fn(async () => '好了')
    const pipeline = new InboundPipeline(makePipelineCtx(transcribe, steers, []))

    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('（语音转写：好了）')
    expect(transcribe).toHaveBeenCalledTimes(1)
    // No steer: the transcript rode the same turn's body.
    expect(steers).toEqual([])
  })

  it('falls back to the [语音] placeholder when the transcription fails', async () => {
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => Promise.reject(new Error('boom')), steers, logs))

    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]')
    expect(steers).toEqual([])
    expect(logs.some(line => line.startsWith('warn: STT failed'))).toBe(true)
  })

  it('falls back to the placeholder on an empty transcript (silence)', async () => {
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const pipeline = new InboundPipeline(makePipelineCtx(async () => '', steers, []))

    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]')
    expect(steers).toEqual([])
  })

  it('gives up after the wait budget and drops the late result', async () => {
    vi.useFakeTimers()
    try {
      const steers: Array<{ chatId: ChatId; text: string }> = []
      const logs: string[] = []
      let settle: (text: string) => void = () => undefined
      const slow = new Promise<string>(resolve => { settle = resolve })
      const pipeline = new InboundPipeline(makePipelineCtx(() => slow, steers, logs))

      const pending = pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
      await vi.advanceTimersByTimeAsync(VOICE_TRANSCRIBE_WAIT_MS + 10)
      expect(await pending).toBe('[语音]')
      expect(logs.some(line => line.includes('语音转写超时'))).toBe(true)

      // The transcript arriving afterwards changes nothing: no second turn.
      settle('来晚了')
      await vi.advanceTimersByTimeAsync(10)
      expect(steers).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('full pipeline: exactly one followup carrying the transcript, no steer', async () => {
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(async () => '好了') } as never,
    })
    h.captured.steers = []
    const voiceBase64 = Buffer.from('fake-mp3-bytes').toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + voiceBase64 } }],
      raw_message: '[CQ:record,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('（语音转写：好了）')
    expect(h.captured.followups[0].text).not.toContain('[语音]')
    // Give any (wrong) steering a chance to fire before asserting.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.captured.steers).toEqual([])
    expect(h.captured.followups).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('full pipeline: a failing transcription keeps [语音] and stays at one turn', async () => {
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(async () => { throw new Error('boom') }) } as never,
    })
    h.captured.steers = []
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3-bytes').toString('base64') } }],
      raw_message: '[CQ:record,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('[语音]')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.captured.steers).toEqual([])
    expect(h.captured.followups).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
