import { describeError } from './errors.js';
/** T4 (PR port 沉默哨兵)：模型只输出沉默哨兵 = 本回合不出站。
 * 判定要求整段文本只含哨兵（允许空白/全角空格/包裹的引号），
 * 免得正常回复里提到这个词被误吞。 */
export const SILENCE_TOKEN = '[[不回]]';
/** T4 (PR port 沉默哨兵)：整段文本剥掉空白与各类包裹引号后是否恰好只含哨兵。 */
export function isSilenceText(text) {
    const stripped = text.replace(/[\s\u3000"'\u0060\u201c\u201d\u2018\u2019\u300c\u300d\uff3b\uff3d]/g, '');
    return stripped !== '' && stripped === SILENCE_TOKEN;
}
/**
 * 静默兜底（2026-11-24 主人批准的「方案四」）：正常由模型自己发言，模型
 * 超过这么长时间一个字的正文都没产出（一路闷头跑工具），插件主动插一句，
 * 免得对面完全安静、不知道这边是不是卡死了。
 *
 * 判定口径：只有「真正产出可见文字」才算打破静默——纯 tool-call 的
 * assistant/message（text 为空）不重置计时器，否则连续跑十个工具就能把
 * 计时器无限续命，兜底永远不触发。
 */
const SILENCE_NUDGE_MS = 150_000;
/** 兜底文案轮换：同一条反复刷会显得像个定时播报器。 */ const SILENCE_NUDGES = [
    '还在跑，这活有点长，我没掉线',
    '还在弄，快好了——别急',
];
/** 一个回合里最多催几次。再久也不催了，省得把聊天刷成播报机。
 *  2026-11-24 主人：每 100 秒一次、最多 5 次 → 随后改成最多 9 次 → 晚上再改成
 *  每 150 秒一次、最多 3 次。 */
const SILENCE_NUDGE_MAX = 3;
/**
 * 兜底要说「做到哪一步」而不是干巴巴一句「还在跑」（主人 2026-11-24）。
 * 插件看不到模型的内心，但看得到它调了哪些工具——按工具名翻译成人话，
 * 拼成「刚看文件，现在在改代码，第 12 步」这种进度汇报。
 */
const TOOL_LABELS = {
    bash: '跑命令',
    pwsh: '跑命令',
    shell: '跑命令',
    read: '看文件',
    write: '写文件',
    edit: '改代码',
    multi_edit: '改代码',
    grep: '搜代码',
    glob: '找文件',
    ls: '看目录',
    web_search: '查资料',
    web_fetch: '翻网页',
    subagent: '派活',
    todo_write: '理计划',
    task: '跑子任务',
};
/** 工具名 → 中文短语；不认识的统一叫「干活」，比漏出英文函数名强。 */
function toolLabel(name) {
    if (name.startsWith('qq_send'))
        return '发消息';
    if (name.startsWith('mcp__'))
        return '调外部工具';
    return TOOL_LABELS[name] ?? '干活';
}
/** 把最近几步工具拼成一句进度短语（同一档连着做只说一次）。 */
function progressPhrase(recent) {
    const labels = recent.map(toolLabel);
    const uniq = labels.filter((label, index) => labels.indexOf(label) === index);
    if (uniq.length === 0)
        return '手上这点';
    if (uniq.length === 1)
        return '一直在' + uniq[0];
    const first = uniq[0];
    const last = uniq[uniq.length - 1];
    return '刚' + first + '，现在在' + last;
}
/**
 * 静默兜底的话术池。
 *
 * 2026-11-24 主人：「兜底的回复还是太死板了」——原来只有两条写死的句子，
 * 触发几次就总是同一句。现在每档给一池，随机挑一条，并且记住上次用过的那条
 * 不再连用，读起来像随口报一句，不像定时器在报数。
 */
const NUDGE_OPENERS = [
    '{where}，还在弄',
    '{where}，还得一会儿',
    '{where}呢，别急',
    '{where}，手上这个没弄完',
    '{where}，正弄到一半',
];
const NUDGE_FOLLOWUPS = [
    '{where}，快好了',
    '{where}，再等等',
    '{where}，马上就有结果',
    '{where}，就差收尾了',
];
/** 从一个池子里挑一条，避开上一次用过的那条。 */
function pickLine(pool, last, where) {
    const candidates = pool.filter((line) => line !== last);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0];
    return chosen.split('{where}').join(where);
}
/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export class InterimTracker {
    ctx;
    /** Per-chat machine records (see InterimCycle). */
    cycles = new WeakMap();
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** The (lazy-created) machine record for one chat. */
    cycle(chat) {
        let record = this.cycles.get(chat);
        if (record === undefined) {
            record = { state: 'idle', inFlight: [], nudgeTimer: undefined, lastVisibleAt: 0, recentTools: [], nudgeCount: 0, lastNudgeLine: '' };
            this.cycles.set(chat, record);
        }
        return record;
    }
    /**
     * 静默兜底（方案四）：arm 一个 90 秒的看门狗。回合真的在跑、但模型一个字
     * 正文都没产出时，到点由插件自己插一句，避免对面完全没动静。
     * 只有 visible text 会重置它（见 onAssistantMessage 里的 noteVisible）。
     */
    armNudge(chatId, chat) {
        const rec = this.cycle(chat);
        if (rec.nudgeTimer !== undefined)
            clearTimeout(rec.nudgeTimer);
        rec.lastVisibleAt = Date.now();
        rec.nudgeTimer = setTimeout(() => {
            rec.nudgeTimer = undefined;
            // 定时器还在就说明回合还没收尾（turn/end / 新回合会 clearNudge 掉它）。
            if (rec.state === 'settling')
                return;
            void this.fireNudge(chatId, chat);
        }, SILENCE_NUDGE_MS);
        // 别让这个定时器拖住宿主进程退出。
        if (typeof rec.nudgeTimer === 'object' && rec.nudgeTimer !== null && 'unref' in rec.nudgeTimer) {
            rec.nudgeTimer.unref();
        }
    }
    /** 兜底那一刻真的发一句进度汇报；连催 N 次还静默就停手，等回合自己结束。 */
    async fireNudge(chatId, chat) {
        const rec = this.cycle(chat);
        if (rec.nudgeCount >= SILENCE_NUDGE_MAX)
            return;
        const where = progressPhrase(rec.recentTools);
        // 2026-11-24 主人：「兜底不能你自己想回啥回啥么 根据做到哪步 像聊天一样的回复」
        // → 先请当前会话模型现写一句；写不出来（没接上 / 超时 / 空串）才回落到话术池。
        let text = '';
        if (this.ctx.generateText !== undefined) {
            text = await this.composeNudge(chatId, where, rec.nudgeCount);
        }
        if (text === '') {
            const pool = rec.nudgeCount === 0 ? NUDGE_OPENERS : NUDGE_FOLLOWUPS;
            text = pickLine(pool, rec.lastNudgeLine, where);
        }
        rec.lastNudgeLine = text;
        rec.nudgeCount += 1;
        this.ctx.log('info', 'silence nudge #' + rec.nudgeCount + ' for ' + chatId + ' (' + where + ')');
        try {
            await this.ctx.sendToChat(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'silence nudge failed: ' + describeError(error));
        }
        // 还在跑就再挂一次（下一次要再等 90 秒，且总数封顶）。
        if (rec.state !== 'settling' && rec.nudgeCount < SILENCE_NUDGE_MAX) {
            this.armNudge(chatId, chat);
        }
    }
    /**
     * 请当前会话模型写一句「正在干嘛」的口语汇报。
     *
     * 目标是像人随口接一句，不是播报器：不列清单、不说「已收到」、不承诺时间、
     * 不叫主人（对面可能是任何人）。限时 20 秒；任何异常都返回空串走话术池兜底。
     */
    async composeNudge(chatId, where, prior) {
        const generate = this.ctx.generateText;
        if (generate === undefined)
            return '';
        const prompt = [
            '你正陪人在 QQ 上聊天，手上还有活没干完，已经安静了一会儿。',
            '请写一句你现在在做什么的口语短句，让对方知道你没停。',
            '',
            '此刻的进度：' + where,
            prior === 0 ? '这是这一轮第一次开口。' : '这一轮已经报过一次，这次要显得比刚才更接近完成。',
            '',
            '要求：',
            '- 一句话，15 字左右，像随口说的，别用书面语',
            '- 不要列清单、不要编号、不要表情符号、不要话题标签',
            '- 不要说「已收到」「稍等」「马上就好」这类空话，要说出具体在做什么',
            '- 不要自称助手，不要称呼对方',
            '- 直接给这句话本身，不要引号、不要前缀',
        ].join('\n');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer)
            timer.unref();
        try {
            const raw = await generate(prompt, { signal: controller.signal });
            const line = (raw ?? '')
                .replace(/^```[\s\S]*?\n|```$/g, '')
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s !== '')
                .map((s) => s.replace(/^[-*•\d.、)．\s]+/, '').trim())
                .filter((s) => s !== '');
            const first = line[0] ?? '';
            // 太长不像随口说的，也不要；超过 60 字直接放弃走兜底。
            if (first === '' || first.length > 60)
                return '';
            return first;
        }
        catch (error) {
            this.ctx.log('warn', 'silence nudge compose failed: ' + describeError(error));
            return '';
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** 有可见正文了：重置看门狗（这条消息本身就已经给对面动静了）。
     *  中间消息关着时压根不挂 —— 跟着开关走（主人 2026-11-24）。 */
    noteVisible(chatId, chat) {
        const rec = this.cycle(chat);
        if (rec.nudgeCount >= SILENCE_NUDGE_MAX)
            return;
        if (!this.ctx.effectiveInterim(chatId)) {
            if (rec.nudgeTimer !== undefined) {
                clearTimeout(rec.nudgeTimer);
                rec.nudgeTimer = undefined;
            }
            return;
        }
        this.armNudge(chatId, chat);
    }
    /** 回合收尾 / 新回合：撤掉看门狗，别让它下一轮再插一句。 */
    clearNudge(chat) {
        const rec = this.cycle(chat);
        if (rec.nudgeTimer !== undefined) {
            clearTimeout(rec.nudgeTimer);
            rec.nudgeTimer = undefined;
        }
        rec.nudgeCount = 0;
    }
    /**
     * turn/start (B8): the new turn accumulates from scratch. Machine: the new
     * turn normalizes the cycle to idle, and arms the silence watchdog — 但只在
     * 中间消息开着时挂：主人 2026-11-24 定「这个都跟开关走」，关掉中间消息就
     * 连兜底也不发，那一轮完全不插话。
     */
    onTurnStart(chatId, chat) {
        const rec = this.cycle(chat);
        rec.state = 'idle';
        rec.recentTools = [];
        if (this.ctx.effectiveInterim(chatId))
            this.armNudge(chatId, chat);
    }
    /** Diagnostic read of one chat's machine state (the state-machine unit
     * tests drive the transition table through this seam). */
    stateOf(chat) {
        return this.cycle(chat).state;
    }
    /** A new user turn starts (wired from dispatchFollowup): the inbound
     * pipeline has already reset the residue fields directly; the machine
     * normalizes to idle so the new cycle accumulates from scratch. */
    onNewUserTurn(chat) {
        this.cycle(chat).state = 'idle';
        this.clearNudge(chat);
    }
    /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
     * then the interim/deferred routing. Machine: every handled text message
     * starts or continues accumulation — accepted from every state (a late
     * message during settlement behaved unguarded before the rewrite; the
     * permissive semantics are kept). */
    onAssistantMessage(chatId, chat, message) {
        // Dedupe: the session may re-emit the same message (streaming/usage
        // updates); each id is handled exactly once, or interims would send
        // repeatedly and flood the loop buffer.
        const messageId = message.id;
        if (messageId !== undefined && chat.lastHandledMessageId === messageId)
            return;
        if (messageId !== undefined)
            chat.lastHandledMessageId = messageId;
        // Host-plane cards (plan review / ask_user_question) never enter the
        // session text stream — the model calls a tool whose arguments carry the
        // content and whose text block is empty, so the `text === ''` early
        // return below would otherwise leave QQ silent. Relay those cards here,
        // before any early return, so the user is never left hanging.
        this.ctx.relayHostCards(chatId, message.content);
        // 兜底进度汇报用：先把这条消息里的工具名记下来（纯 tool-call 消息
        // text 为空、下面会早退，所以必须在早退之前记）。
        for (const block of message.content) {
            if (block.type !== 'tool-call')
                continue;
            const name = typeof block.name === 'string'
                ? block.name
                : '';
            if (name === '')
                continue;
            const recent = this.cycle(chat).recentTools;
            recent.push(name);
            if (recent.length > 6)
                recent.shift();
        }
        const text = message.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
        if (text === '')
            return;
        // T4 (PR port 沉默哨兵)：整段只有沉默哨兵 → 哨兵本身不进入出站。
        // 评审修正：不无条件清 loopPending——同回合「先发言后沉默」时已排队的
        // deferred 文本（模型公开说过的话）不能被吞：保留给 turn/end（interim
        // 模式经 settleLoop 作终稿发出，instant 模式经 onTurnEnd 终稿路径发出）；
        // 若哨兵之后还有真实消息，它照正常路径先 flush 为插播。哨兵本身从不写入
        // loopPending，两条终稿路径已有的 isSilenceText 守卫兜底不发。
        if (isSilenceText(text)) {
            this.ctx.log('info', 'silenced turn for ' + chatId);
            return;
        }
        // 兜底看门狗：这条消息真有可见正文 → 对面已经看到动静了，重新计时。
        this.noteVisible(chatId, chat);
        this.cycle(chat).state = 'accumulating';
        if (this.ctx.effectiveInterim(chatId)) {
            // The arriving message proves the previously deferred text interim —
            // flush it now, regardless of this message's shape.
            const prior = chat.loopPending;
            if (prior !== null) {
                chat.loopPending = null;
                this.sendInterim(chatId, chat, prior);
            }
            // A message carrying tool calls can never be the final reply (the
            // model continues after the tool) — send it immediately instead of
            // deferring one step, so QQ receives interims without the one-step
            // lag. Only tool-free text stays deferred until turn/end proves it
            // either interim (next assistant/message) or final.
            const hasToolCall = message.content.some(block => block.type === 'tool-call');
            if (hasToolCall) {
                this.sendInterim(chatId, chat, text);
            }
            else {
                chat.loopPending = text;
            }
        }
        else {
            chat.loopPending = text;
        }
    }
    /** The onSessionEvent turn/end interim part: settle the trail when the
     * effective mode is interim, else flush the deferred final. The rest of
     * the branch (error notice, typing, busy, flush) stays bridge-resident.
     * Machine: idle/accumulating → settling (interim) or idle (instant); a
     * turn/end while a settlement is already draining is skipped — the second
     * pass found only a drained trail before the rewrite (a harmless no-op),
     * and skipping it keeps the two passes from racing. */
    onTurnEnd(chatId, chat) {
        const rec = this.cycle(chat);
        // 回合收尾：撤掉静默兜底看门狗（它只在跑的时候才该说话）。
        this.clearNudge(chat);
        if (rec.state === 'settling')
            return;
        if (this.ctx.effectiveInterim(chatId)) {
            rec.state = 'settling';
            void this.settleLoop(chatId, chat);
        }
        else {
            rec.state = 'idle';
            const raw = chat.loopPending;
            if (raw === null) {
                // 这一轮没有正文要发 → 直接算跑完。
                return;
            }
            chat.loopPending = null;
            // T4 (PR port 沉默哨兵)：整段只有哨兵 → 只记日志，不发送。
            if (isSilenceText(raw)) {
                this.ctx.log('info', 'silenced turn for ' + chatId);
                return;
            }
            // 2026-11-22 双发闸整套删除（主人定：正常聊天不调 qq_send_text），正文原样发。
            // 2026-11-24 语音条这道恢复（主人当天先让删、几小时后又说「触发了这个转语音
            // 之后那一回合正文就不要发了」）：语音条那轮的话由语音承载，正文再发一遍
            // 就是 QQ 里两条一样的内容。
            const final = raw;
            if (final.trim() === '') {
                this.ctx.log('info', 'final dropped (empty): ' + chatId);
                return;
            }
            if (this.dropVoiceDuplicate(chatId, chat))
                return;
            this.ctx.sendToChat(chatId, final, { queuable: true }).catch(error => {
                this.ctx.log('warn', 'final send failed: ' + describeError(error));
            });
        }
    }
    /**
     * 本地加（2026-11-23，2026-11-24 恢复）：语音条回合的正文丢弃判定。掷骰命中
     * 语音条、并且本回合确实发出去了一条语音 —— 那语音里念的就是这句话，正文再
     * 发一遍就是 QQ 里两条一模一样的内容。
     * 只发文字没发语音（模型没调 qq_send_voice）时不丢，否则那轮会彻底没声音也没字。
     */
    dropVoiceDuplicate(chatId, chat) {
        if (!chat.turnFormVoice || !chat.voiceSentThisTurn)
            return false;
        this.ctx.log('info', 'final dropped (voice turn): ' + chatId);
        return true;
    }
    /** Send one interim live and book it SYNCHRONOUSLY (M3-D2a): a placeholder
     * entry enters the loop buffer at enqueue time; when the send completes it
     * is backfilled in place with one entry per QQ message id. The send's
     * settled promise joins the cycle's in-flight set — the trail no longer
     * depends on a push callback racing the turn/end snapshot. */
    sendInterim(chatId, chat, text) {
        const rec = this.cycle(chat);
        const entry = { id: '', text, sentAt: 0 };
        chat.loopBuffer.push(entry);
        const settled = this.ctx.sendToChat(chatId, text).then(ids => {
            this.completeInterim(chatId, chat, entry, ids);
        }, error => {
            this.dropInterim(chat, entry);
            this.ctx.log('warn', 'interim send failed: ' + describeError(error));
        });
        rec.inFlight.push(settled);
        void settled.then(() => {
            const at = rec.inFlight.indexOf(settled);
            if (at >= 0)
                rec.inFlight.splice(at, 1);
        });
    }
    /** Send completion: backfill the placeholder in place with one entry per
     * message id (a placeholder already dropped from the buffer — the inbound
     * residue reset swapped the array — is never re-added). 2026-11-24 起不再
     * 排自动撤回定时器：中间消息就留在聊天里。 */
    completeInterim(chatId, chat, entry, ids) {
        void chatId;
        const sentAt = Date.now();
        const index = chat.loopBuffer.indexOf(entry);
        if (index >= 0) {
            chat.loopBuffer.splice(index, 1, ...ids.map((id, i) => ({ id, text: i === 0 ? entry.text : '', sentAt })));
        }
    }
    /** Send failure: drop the placeholder so the cycle never summarizes or
     * recalls a message that never reached QQ (the pre-rewrite code simply
     * never pushed an entry on failure). */
    dropInterim(chat, entry) {
        const index = chat.loopBuffer.indexOf(entry);
        if (index >= 0)
            chat.loopBuffer.splice(index, 1);
    }
    /**
     * Settle a finished turn's interim trail (interimMessages on): drain the
     * send chain (cross-send ordering, as before) and the cycle's in-flight
     * set (bookkeeping: enqueue count == completion count — no reliance on
     * microtask registration order), then send the deferred final text.
     *
     * 2026-11-24 主人让去掉「自动撤回中间消息」和「中间消息保留时长」：中间
     * 消息发出去就留在聊天里，回合末不再发 t2i 小结卡、也不再 delete_msg 撤回。
     */
    async settleLoop(chatId, chat) {
        const rec = this.cycle(chat);
        try {
            await this.ctx.chainTail(chatId);
        }
        catch {
            // failures already settle the enqueue chain; keep going
        }
        // Bookkeeping drain: every interim booked at enqueue time has completed
        // (ids backfilled, or its placeholder dropped on failure) before the
        // snapshot — this replaces the pre-rewrite guarantee that leaned on the
        // push callback being registered before the chain tail's recovery link.
        await Promise.all(rec.inFlight);
        chat.loopBuffer = [];
        if (chat.loopPending !== null) {
            const raw = chat.loopPending;
            chat.loopPending = null;
            // T4 (PR port 沉默哨兵)：整段只有哨兵 → 只记日志，不发送。
            if (isSilenceText(raw)) {
                this.ctx.log('info', 'silenced turn for ' + chatId);
            }
            else if (this.dropVoiceDuplicate(chatId, chat)) {
                // 语音条已念过这句话，正文不再发。
            }
            else {
                // 2026-11-22 双发闸整套删除（主人定：正常聊天不调 qq_send_text），正文原样发。
                try {
                    await this.ctx.sendToChat(chatId, raw, { queuable: true });
                }
                catch (error) {
                    this.ctx.log('warn', 'final send failed: ' + describeError(error));
                }
            }
        }
        // The settlement owns 'settling' only until it completes; a user turn or
        // a new turn starting mid-drain already moved the machine on.
        if (rec.state === 'settling')
            rec.state = 'idle';
    }
}
