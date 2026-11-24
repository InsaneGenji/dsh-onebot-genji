/**
 * Interim domain (M2-D1-PR5 extraction; M3-D2a explicit machine): the
 * loop-merge outbound mode — live interim sends and the turn/end settlement
 * (the deferred final), plus the assistant/message interim routing (id
 * dedupe, deferred-text flush, tool-call short-circuit). M3-D2a: the per-chat
 * cycle runs an explicit idle/accumulating/settling state machine.
 *
 * 2026-11-24 主人让把「自动撤回中间消息」和「中间消息保留时长」整套去掉
 * （连同设置页那两个键）：中间消息发出去就留在聊天里，不再排撤回定时器、
 * 也不再发整轮 t2i 小结卡——回合末只发最终回复。所以要保留它是默认行为，
 * 不需要开关。
 * @module dsh-onebot/interim
 */
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type { BridgeConfig } from './bridge.js';
import type { ChatId } from './chat.js';
import type { SendOptions } from './outbound.js';
/** T4 (PR port 沉默哨兵)：模型只输出沉默哨兵 = 本回合不出站。
 * 判定要求整段文本只含哨兵（允许空白/全角空格/包裹的引号），
 * 免得正常回复里提到这个词被误吞。 */
export declare const SILENCE_TOKEN = "[[\u4E0D\u56DE]]";
/** T4 (PR port 沉默哨兵)：整段文本剥掉空白与各类包裹引号后是否恰好只含哨兵。 */
export declare function isSilenceText(text: string): boolean;
/** Narrow view of a live chat the interim tracker may touch — the structural
 * subset of the bridge's ChatAgent carrying the interim state. The storage
 * itself stays on ChatAgent: the inbound pipeline's residue reset, the /stop
 * /retry manual clears and the registry dispose paths touch the same fields. */
export interface InterimChat {
    /** Text deferred one step in either outbound mode — proven interim by the
     * next assistant/message (flushed live), else the final at turn/end.
     * M3-D2a: the former instant-mode-only pendingFinal folded in. */
    loopPending: string | null;
    /** 本回合发出去的中间消息（只做记账：回合内诊断 / 日志用）。
     *  2026-11-24 起不再用于撤回和小结卡——中间消息发出去就留在聊天里。 */
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    /** Last assistant message id already handled — duplicate session events
     * (streaming/usage re-emits of the same message) must not re-send it. */
    lastHandledMessageId: string | undefined;
    /** 本地加（2026-11-23）：本回合掷骰命中语音条。 */
    turnFormVoice: boolean;
    /** 本地加（2026-11-23）：本回合已成功发出一条语音条。两者同时为真时，
     * 回合末的正文就是同一句话的重复，丢弃不发。 */
    voiceSentThisTurn: boolean;
}
/** The explicit per-chat cycle state (M3-D2a). 'idle': nothing deferred or
 * in flight. 'accumulating': a turn is producing text (interims booking,
 * deferred text awaiting proof). 'settling': turn/end started the settlement
 * drain. Transitions live only in the entry methods (onAssistantMessage /
 * onTurnEnd / onNewUserTurn, plus the turn/start normalization). */
export type InterimState = 'idle' | 'accumulating' | 'settling';
/** The bridge capabilities the interim tracker touches. Deliberately narrower
 * than BridgeDeps: the outbound send paths as callbacks (the PR2 facade
 * contract — zero direct dependency on the outbound internals), the raw
 * OneBot action gate (delete_msg recalls), the send-chain tail settleLoop
 * drains, the host-card relay and the per-chat outbound-mode resolver the
 * assistant/message branch reads, the log, and the config subset the interim
 * domain actually reads. */
export interface InterimContext {
    /** Full outbound pipeline send (interim lines, deferred finals). */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** The chat's outbound send-chain tail (settleLoop drains it before
     * snapshotting the interim trail). */
    chainTail(chatId: ChatId): Promise<unknown>;
    /** Host-plane card relay (assistant/message branch, before any early return). */
    relayHostCards(chatId: ChatId, content: readonly unknown[]): void;
    /** Per-chat effective outbound mode (/mode override → global config). */
    effectiveInterim(chatId: ChatId): boolean;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** 2026-11-24 主人：「兜底不能你自己想回啥回啥么」——用当前会话模型现写一句
     *  像聊天的话报进度，代替写死的话术池。缺省 / 抛错 / 超时都回落到话术池。 */
    generateText?: (prompt: string, options?: {
        signal?: AbortSignal;
    }) => Promise<string>;
    /** 2026-11-24 起中间域不再读任何与撤回/小结卡有关的配置（那套已删）。 */
    config: Pick<BridgeConfig, never>;
}
/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export declare class InterimTracker {
    private readonly ctx;
    /** Per-chat machine records (see InterimCycle). */
    private readonly cycles;
    constructor(ctx: InterimContext);
    /** The (lazy-created) machine record for one chat. */
    private cycle;
    /**
     * 静默兜底（方案四）：arm 一个 90 秒的看门狗。回合真的在跑、但模型一个字
     * 正文都没产出时，到点由插件自己插一句，避免对面完全没动静。
     * 只有 visible text 会重置它（见 onAssistantMessage 里的 noteVisible）。
     */
    private armNudge;
    /** 兜底那一刻真的发一句进度汇报；连催 N 次还静默就停手，等回合自己结束。 */
    private fireNudge;
    /**
     * 请当前会话模型写一句「正在干嘛」的口语汇报。
     *
     * 目标是像人随口接一句，不是播报器：不列清单、不说「已收到」、不承诺时间、
     * 不叫主人（对面可能是任何人）。限时 20 秒；任何异常都返回空串走话术池兜底。
     */
    private composeNudge;
    /** 有可见正文了：重置看门狗（这条消息本身就已经给对面动静了）。
     *  中间消息关着时压根不挂 —— 跟着开关走（主人 2026-11-24）。 */
    private noteVisible;
    /** 回合收尾 / 新回合：撤掉看门狗，别让它下一轮再插一句。 */
    private clearNudge;
    /**
     * turn/start (B8): the new turn accumulates from scratch. Machine: the new
     * turn normalizes the cycle to idle, and arms the silence watchdog — 但只在
     * 中间消息开着时挂：主人 2026-11-24 定「这个都跟开关走」，关掉中间消息就
     * 连兜底也不发，那一轮完全不插话。
     */
    onTurnStart(chatId: ChatId, chat: InterimChat): void;
    /** Diagnostic read of one chat's machine state (the state-machine unit
     * tests drive the transition table through this seam). */
    stateOf(chat: InterimChat): InterimState;
    /** A new user turn starts (wired from dispatchFollowup): the inbound
     * pipeline has already reset the residue fields directly; the machine
     * normalizes to idle so the new cycle accumulates from scratch. */
    onNewUserTurn(chat: InterimChat): void;
    /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
     * then the interim/deferred routing. Machine: every handled text message
     * starts or continues accumulation — accepted from every state (a late
     * message during settlement behaved unguarded before the rewrite; the
     * permissive semantics are kept). */
    onAssistantMessage(chatId: ChatId, chat: InterimChat, message: AssistantMessage): void;
    /** The onSessionEvent turn/end interim part: settle the trail when the
     * effective mode is interim, else flush the deferred final. The rest of
     * the branch (error notice, typing, busy, flush) stays bridge-resident.
     * Machine: idle/accumulating → settling (interim) or idle (instant); a
     * turn/end while a settlement is already draining is skipped — the second
     * pass found only a drained trail before the rewrite (a harmless no-op),
     * and skipping it keeps the two passes from racing. */
    onTurnEnd(chatId: ChatId, chat: InterimChat): void;
    /**
     * 本地加（2026-11-23，2026-11-24 恢复）：语音条回合的正文丢弃判定。掷骰命中
     * 语音条、并且本回合确实发出去了一条语音 —— 那语音里念的就是这句话，正文再
     * 发一遍就是 QQ 里两条一模一样的内容。
     * 只发文字没发语音（模型没调 qq_send_voice）时不丢，否则那轮会彻底没声音也没字。
     */
    private dropVoiceDuplicate;
    /** Send one interim live and book it SYNCHRONOUSLY (M3-D2a): a placeholder
     * entry enters the loop buffer at enqueue time; when the send completes it
     * is backfilled in place with one entry per QQ message id. The send's
     * settled promise joins the cycle's in-flight set — the trail no longer
     * depends on a push callback racing the turn/end snapshot. */
    private sendInterim;
    /** Send completion: backfill the placeholder in place with one entry per
     * message id (a placeholder already dropped from the buffer — the inbound
     * residue reset swapped the array — is never re-added). 2026-11-24 起不再
     * 排自动撤回定时器：中间消息就留在聊天里。 */
    private completeInterim;
    /** Send failure: drop the placeholder so the cycle never summarizes or
     * recalls a message that never reached QQ (the pre-rewrite code simply
     * never pushed an entry on failure). */
    private dropInterim;
    /**
     * Settle a finished turn's interim trail (interimMessages on): drain the
     * send chain (cross-send ordering, as before) and the cycle's in-flight
     * set (bookkeeping: enqueue count == completion count — no reliance on
     * microtask registration order), then send the deferred final text.
     *
     * 2026-11-24 主人让去掉「自动撤回中间消息」和「中间消息保留时长」：中间
     * 消息发出去就留在聊天里，回合末不再发 t2i 小结卡、也不再 delete_msg 撤回。
     */
    private settleLoop;
}
