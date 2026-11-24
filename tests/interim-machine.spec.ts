/**
 * InterimTracker state-machine unit tests (M3-D2a): the transition table is
 * driven directly against a hand-built InterimChat plus a stub InterimContext
 * — no WebSocket harness. Every entry method × prior state is covered,
 * including the permissive transitions that keep the pre-rewrite semantics
 * (a late assistant/message during settlement, a double turn/end) and the
 * synchronous booking/drain behavior (placeholder at enqueue, id backfill on
 * completion, placeholder drop on send failure).
 *
 * 2026-11-24 主人让去掉「自动撤回中间消息」和「中间消息保留时长」：中间消息
 * 发出去就留在聊天里，回合末不再发 t2i 小结卡、也不再 delete_msg 撤回。本文件
 * 相应删掉了撤回定时器 / 小结卡 / 撤回队列的全部断言。
 * @module dsh-onebot/tests/interim-machine
 */
import { describe, expect, it, vi } from 'vitest'

import { InterimTracker } from '../src/interim.js'
import type { InterimChat } from '../src/interim.js'

function makeHarness(opts?: {
  interim?: boolean
  failSends?: boolean
  sendIds?: string[]
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>
}) {
  const sentTexts: string[] = []
  const prompts: string[] = []
  let interimMode = opts?.interim ?? true
  const tracker = new InterimTracker({
    sendToChat: async (_chatId, text) => {
      if (opts?.failSends === true) throw new Error('send down')
      sentTexts.push(text)
      return opts?.sendIds ?? ['7']
    },
    chainTail: async () => undefined,
    relayHostCards: () => undefined,
    effectiveInterim: () => interimMode,
    log: () => undefined,
    generateText: opts?.generateText === undefined
      ? undefined
      : async (prompt, options) => {
        prompts.push(prompt)
        return opts.generateText!(prompt, options)
      },
    config: {},
  })
  const chat: InterimChat = {
    loopPending: null,
    loopBuffer: [],
    lastHandledMessageId: undefined,
    turnFormVoice: false,
    voiceSentThisTurn: false,
  }
  const assistant = (text: string, messageOpts?: { toolCall?: boolean; id?: string }) => ({
    id: messageOpts?.id,
    content: messageOpts?.toolCall === true
      ? [{ type: 'text', text }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]
      : [{ type: 'text', text }],
  })
  // Fixed tick for microtask-only drains (send backfill etc. — microtasks
  // settle before this timer fires). The settlement drain is bounded by the
  // terminal state ('idle', set last in settleLoop) via vi.waitFor instead,
  // so load can never outrun a fixed timeout.
  const settle = () => new Promise(resolve => setTimeout(resolve, 120))
  return { tracker, chat, sentTexts, prompts, assistant, settle, setMode: (value: boolean) => { interimMode = value } }
}

describe('InterimTracker state machine (M3-D2a)', () => {
  it('idle × assistant(interim, tool-free) → accumulating: text deferred, nothing sent', () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('第一步')
    expect(h.sentTexts).toEqual([])
    expect(h.chat.loopBuffer).toEqual([])
  })

  it('idle × assistant(interim, tool call) → accumulating: interim booked at enqueue, sent live', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('带工具', { toolCall: true }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    // Booked synchronously at enqueue time (placeholder), before the send.
    expect(h.chat.loopBuffer).toHaveLength(1)
    expect(h.chat.loopBuffer[0].text).toBe('带工具')
    await h.settle()
    expect(h.chat.loopBuffer[0].id).toBe('7')
    expect(h.chat.loopBuffer[0].sentAt).toBeGreaterThan(0)
    expect(h.sentTexts).toEqual(['带工具'])
  })

  it('accumulating × assistant(interim) → accumulating: the prior deferred text flushes as interim', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第二步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('第二步')
    await h.settle()
    expect(h.sentTexts).toEqual(['第一步'])
    expect(h.chat.loopBuffer).toHaveLength(1)
    expect(h.chat.loopBuffer[0].text).toBe('第一步')
  })

  it('accumulating × turn/end (interim) → settling → idle: the final goes out, nothing is recalled', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('中间步', { toolCall: true }) as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('最终答') as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    await vi.waitFor(() => expect(h.tracker.stateOf(h.chat)).toBe('idle'))
    // 只有两条：中间步实时发出 + 最终答；没有小结卡、没有撤回。
    expect(h.sentTexts).toEqual(['中间步', '最终答'])
    expect(h.chat.loopBuffer).toHaveLength(0)
    expect(h.chat.loopPending).toBeNull()
  })

  it('idle × turn/end (interim) → settling → idle with an empty trail: no final', async () => {
    const h = makeHarness()
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    await h.settle()
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.sentTexts).toEqual([])
  })

  it('settling × turn/end (double) → skipped: one settle, machine returns to idle once', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('中间步', { toolCall: true }) as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await vi.waitFor(() => expect(h.tracker.stateOf(h.chat)).toBe('idle'))
    expect(h.sentTexts).toEqual(['中间步'])
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
  })

  it('settling × assistant (late message) → accumulating (permissive, pre-rewrite semantics)', async () => {
    const h = makeHarness()
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('迟到步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('迟到步')
    await h.settle()
    // The completed empty settlement did not stomp the new accumulation.
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
  })

  it('accumulating × turn/end (instant mode) → idle: the deferred text is the final', async () => {
    const h = makeHarness({ interim: false })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('最终答') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('最终答')
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    await h.settle()
    expect(h.sentTexts).toEqual(['最终答'])
  })

  it('idle × turn/end (instant mode) → idle, nothing sent', () => {
    const h = makeHarness({ interim: false })
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.sentTexts).toEqual([])
  })

  it('instant × assistant mid-cycle then a mode flip to interim: the next message flushes the deferred text (unified field)', async () => {
    const h = makeHarness({ interim: false })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('暂存文本') as never)
    h.setMode(true)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('新文本') as never)
    await h.settle()
    expect(h.sentTexts).toEqual(['暂存文本'])
    expect(h.chat.loopPending).toBe('新文本')
  })

  it('accumulating/settling × onNewUserTurn → idle', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    h.tracker.onNewUserTurn(h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    h.tracker.onNewUserTurn(h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    await h.settle()
  })

  it('turn/start → idle', () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('一步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    h.tracker.onTurnStart('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
  })

  it('empty text is a no-op for the machine; a duplicate message id is ignored entirely', () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, { id: undefined, content: [{ type: 'text', text: '' }] } as never)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('一步', { id: 'm1' }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('重复', { id: 'm1' }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('一步')
  })

  it('a failed send drops its placeholder: never sent as a final, buffer stays empty', async () => {
    const h = makeHarness({ failSends: true })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('发不出去', { toolCall: true }) as never)
    expect(h.chat.loopBuffer).toHaveLength(1)
    await h.settle()
    expect(h.chat.loopBuffer).toHaveLength(0)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    expect(h.sentTexts).toEqual([])
  })

  it('a multi-id send expands the placeholder into one entry per message id', async () => {
    const h = makeHarness({ sendIds: ['7', '8'] })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('分两段', { toolCall: true }) as never)
    expect(h.chat.loopBuffer).toHaveLength(1)
    await h.settle()
    expect(h.chat.loopBuffer.map(entry => entry.id)).toEqual(['7', '8'])
  })

  it('settlement keeps every interim on screen: no delete_msg, no summary card', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('会留着', { toolCall: true }) as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('最终答') as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await vi.waitFor(() => expect(h.tracker.stateOf(h.chat)).toBe('idle'))
    expect(h.sentTexts).toEqual(['会留着', '最终答'])
    expect(h.chat.loopBuffer).toHaveLength(0)
  })
})

describe('2026-11-24 静默兜底（方案四：150 秒没动静插件主动插一句）', () => {
  /** 这个 describe 全程用假时钟：真等 90 秒会把测试拖死。 */
  const setup = (opts?: { interim?: boolean }) => {
    vi.useFakeTimers()
    const h = makeHarness(opts)
    return h
  }

  it('一路纯工具调用、150 秒一个字没说 → 到点自己插一句，说清做到哪一步', async () => {
    const h = setup()
    h.tracker.onTurnStart('private:10001', h.chat)
    // 三次纯工具调用：看文件 → 改代码 → 跑命令（text 为空，不算「说过话」）。
    const tools = ['read', 'edit', 'bash']
    for (let i = 0; i < tools.length; i += 1) {
      h.tracker.onAssistantMessage('private:10001', h.chat, { id: 'tool' + i, content: [{ type: 'tool-call', id: 'c', name: tools[i], arguments: '{}' }] } as never)
    }
    expect(h.sentTexts).toEqual([])
    await vi.advanceTimersByTimeAsync(150_000)
    expect(h.sentTexts).toHaveLength(1)
    // 说的不是「还在跑」这种干巴巴一句，而是带着进度：刚看文件，现在在跑命令。
    expect(h.sentTexts[0]).toContain('看文件')
    expect(h.sentTexts[0]).toContain('跑命令')
    vi.useRealTimers()
  })

  it('中途说过话 → 看门狗重置，150 秒内不再插话', async () => {
    const h = setup()
    h.tracker.onTurnStart('private:10001', h.chat)
    await vi.advanceTimersByTimeAsync(60_000)
    // 60 秒时说了一句（可见正文），计时重来。
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('先看一眼', { toolCall: true }) as never)
    await vi.advanceTimersByTimeAsync(140_000)
    // 距上次说话只有 140 秒，不该催。
    expect(h.sentTexts).toEqual(['先看一眼'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.sentTexts).toHaveLength(2)
    vi.useRealTimers()
  })

  it('回合结束就撤掉看门狗：turn/end 之后不会凭空冒一句', async () => {
    const h = setup()
    h.tracker.onTurnStart('private:10001', h.chat)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.sentTexts).toEqual([])
    vi.useRealTimers()
  })

  it('中间消息关掉时连兜底也不发：整套跟着开关走', async () => {
    const h = setup({ interim: false })
    h.tracker.onTurnStart('private:10001', h.chat)
    for (let i = 0; i < 3; i += 1) {
      h.tracker.onAssistantMessage('private:10001', h.chat, { id: 'tool' + i, content: [{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } as never)
    }
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.sentTexts).toEqual([])
    vi.useRealTimers()
  })

  it('同一个回合最多催三次，之后彻底安静（2026-11-24 晚：150 秒一次、上限 3 次）', async () => {
    const h = setup()
    h.tracker.onTurnStart('private:10001', h.chat)
    for (let i = 0; i < 15; i += 1) {
      await vi.advanceTimersByTimeAsync(150_000)
    }
    expect(h.sentTexts).toHaveLength(3)
    vi.useRealTimers()
  })

  it('两次催的话不一样：话术池随机且不连用同一句（2026-11-24 主人：太死板了）', async () => {
    const h = setup()
    h.tracker.onTurnStart('private:10001', h.chat)
    h.tracker.onAssistantMessage('private:10001', h.chat, {
      id: 'tool0',
      content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }],
    } as never)
    await vi.advanceTimersByTimeAsync(150_000)
    await vi.advanceTimersByTimeAsync(150_000)
    expect(h.sentTexts).toHaveLength(2)
    expect(h.sentTexts[0]).toContain('看文件')
    expect(h.sentTexts[1]).toContain('看文件')
    expect(h.sentTexts[0]).not.toBe(h.sentTexts[1])
    vi.useRealTimers()
  })

  it('接了会话模型就直接用它写的话（不再套话术池）（2026-11-24 主人：不能你自己想回啥回啥么）', async () => {
    const h = makeHarness({
      generateText: async () => '这个测试跑一半了，我再盯两眼',
    })
    vi.useFakeTimers()
    h.tracker.onTurnStart('private:10001', h.chat)
    h.tracker.onAssistantMessage('private:10001', h.chat, {
      id: 'tool0',
      content: [{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }],
    } as never)
    await vi.advanceTimersByTimeAsync(150_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain('跑命令')
    expect(h.sentTexts).toEqual(['这个测试跑一半了，我再盯两眼'])
    vi.useRealTimers()
  })

  it('模型写崩了 / 返回空串 / 太长 → 回落到话术池，不能让对面没动静', async () => {
    for (const bad of [async () => { throw new Error('model down') }, async () => '', async () => '太长了'.repeat(60)]) {
      const h = makeHarness({ generateText: bad })
      vi.useFakeTimers()
      h.tracker.onTurnStart('private:10001', h.chat)
      h.tracker.onAssistantMessage('private:10001', h.chat, {
        id: 'tool0',
        content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }],
      } as never)
      await vi.advanceTimersByTimeAsync(150_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.sentTexts).toHaveLength(1)
      expect(h.sentTexts[0]).toContain('看文件')
      vi.useRealTimers()
    }
  })
})

describe('2026-11-24 语音条回合的正文去重', () => {
  const drive = async (opts: { interim?: boolean; voiceTurn: boolean; voiceSent: boolean }) => {
    const h = makeHarness({ interim: opts.interim ?? false })
    h.chat.turnFormVoice = opts.voiceTurn
    h.chat.voiceSentThisTurn = opts.voiceSent
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('那就这样') as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    return h.sentTexts
  }

  it('命中语音条且真发出了语音 → 正文不发（instant 模式）', async () => {
    expect(await drive({ voiceTurn: true, voiceSent: true })).toEqual([])
  })

  it('命中语音条且真发出了语音 → 正文不发（interim 模式）', async () => {
    expect(await drive({ interim: true, voiceTurn: true, voiceSent: true })).toEqual([])
  })

  it('命中语音条但没发语音 → 正文照发，别让那轮彻底没声', async () => {
    expect(await drive({ voiceTurn: true, voiceSent: false })).toEqual(['那就这样'])
  })

  it('普通回合（没命中语音条）→ 正文照发', async () => {
    expect(await drive({ voiceTurn: false, voiceSent: true })).toEqual(['那就这样'])
  })
})
