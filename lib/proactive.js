/**
 * 主动搭话（原 startup/qq-alive.mjs 的逻辑，2026-11-19 主人要求合并进插件）。
 *
 * 为什么搬进来：原来是一个独立的 node 进程（qq-alive.mjs），靠 qq-follow-dsh.ps1
 * 守护、自己连 NapCat WS 发消息、自己读 state 文件。合并之后：
 *   - 生命周期跟插件一致（插件在就在，插件停就停）；
 *   - 开关和门槛参数全进设置面板（proactiveEnabled 等，见 index.js 的 Config）；
 *   - 发送复用插件现成的出站管线（bridge.sendToChat → 频控/审计/分条都照旧）。
 *
 * 保留的行为：
 *   - 门槛：安静时段、主人刚聊过、自己刚说过、今天说够了、上次试过没发的间隔；
 *   - 模型判 PASS 就不发（不硬编尬话）；
 *   - burst（拆 2~3 条连着发）、偶尔的错字（humanize）、CQ 码清洗；
 *   - 状态文件沿用 ~/.dsh/alive-state.json，接得上旧进程的时间线。
 *   - 2026-11-22 主人让把「聊完补话」（原 followupTick，45~180 秒窗口内再补一
 *     句）整块删掉：跟主动搭话功能重叠、行为又难以预期。相关配置键、状态字段、
 *     prompt 构造一并移除，旧的 alive-state.json 里遗留的 followupToday /
 *     lastFollowupFor 读进来会被忽略（不认识的键不参与判定）。
 *
 * 不搬的部分：早晚安（主人 2026-11-19 明确去掉）、语音发送、语感库自动重建
 * （重建脚本在 workspace 里，属于外部工具，插件只读 pool.json）。
 *
 * 2026-11-19 搬进源码时去掉对本仓库其他模块的依赖：本文件自包含，只碰
 * node:fs / node:path；bridge / config / log 一律用结构化接口描述（不 import
 * bridge.ts、prompt.ts 等），这样即使那几处正在改也不会把这个文件带崩。
 * @module dsh-onebot/proactive
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { uptime as osUptime } from 'node:os';
import { join } from 'node:path';
/** 配置默认值：Config.proactive 用 .default({}) 时不保证补齐子字段，这里垫一层，
 *  免得 undefined 把阈值判断打成恒假、让主动搭话静默失效。与 lib/index.js 的
 *  Config.proactive 逐项对齐（不含接口地址/模型名/Key —— 2026-11-19 起走当前会话模型）。 */
export const PROACTIVE_DEFAULTS = {
    enabled: true,
    targetUsers: [],
    minIdleMinutes: 60,
    minGapMinutes: 90,
    maxPerDay: 6,
    quietFrom: 22,
    quietTo: 6,
    attemptGapMinutes: 30,
    burstProb: 0.5,
};
/** 常规开口的节拍：3~9 分钟随机。 */
const TICK_MIN_MS = 180_000;
const TICK_SPAN_MS = 360_000;
/** 生成时塞进 prompt 的最近聊天条数。 */
const HISTORY_COUNT = 12;
const STYLE_PAIRS = 4;
/** 拆条发送时的间隔。 */
const SPLIT_DELAY_MIN_MS = 1_200;
const SPLIT_DELAY_SPAN_MS = 1_800;
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
/** 本地日期串（YYYY-MM-DD），用于「今天说了几次」的跨天重置。 */
function localDay(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
/** 现在几点（HH:MM），给搭话当线索用。 */
export function clockOf(date = new Date()) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
/** 这台机器开机多久了（分钟）。2026-11-21 主人要求：把这事实当线索喂进去——
 *  早上八点能跑，本身就说明他昨晚关过机、现在又开回来了，不该再问「关了没」。 */
export function uptimeMinutes() {
    try {
        return osUptime() / 60;
    }
    catch {
        return 0;
    }
}
/** 情境线索：现在是几点、机器刚开机还是已经开了一整天。
 *  只给事实，不给「该不该问关了没」这种规矩。 */
export function situationLines(now = new Date(), bootMin = uptimeMinutes()) {
    const lines = [];
    const boot = Number.isFinite(bootMin) && bootMin > 0 ? Math.round(bootMin) : 0;
    let tail = '';
    if (boot > 0) {
        if (boot < 120)
            tail = `，这台电脑 ${boot} 分钟前才开机（昨晚关过，刚回来）`;
        else if (boot < 60 * 24)
            tail = `，这台电脑已经开了 ${Math.round(boot / 60)} 小时`;
        else
            tail = `，这台电脑已经开了 ${Math.round(boot / 60 / 24)} 天`;
    }
    lines.push(`【当前情境】现在 ${clockOf(now)}${tail}。`);
    return lines;
}
/** 把 NapCat 的 raw_message 里那堆 CQ 码压成中文占位，不然生成时接不上话头。 */
export function cleanCq(text, masterQQ = '') {
    return String(text ?? '')
        .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
        .replace(/\[CQ:mface,[^\]]*\]/g, '[表情]')
        .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
        .replace(/\[CQ:record,[^\]]*\]/g, '[语音]')
        .replace(/\[CQ:video,[^\]]*\]/g, '[视频]')
        .replace(/\[CQ:file,[^\]]*\]/g, '[文件]')
        .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, (_match, qq) => (String(qq) === String(masterQQ) ? '@主人' : '@某人'))
        .replace(/\[CQ:reply,[^\]]*\]/g, '')
        .replace(/\[CQ:[^\]]*\]/g, '')
        .replace(/\[CQ:[^\]]*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 清洗模型输出：去括号旁白、去前缀引号、去句末句号、太长截断。 */
const PLACEHOLDER_ONLY_RE = /^(\s*(\[(图片|语音|视频|表情包|文件|动画表情|闪照|音乐|链接|位置|卡片)[^\]]*\]|\[CQ:[^\]]+\]|[（(](图片|语音|视频)[）)]|[.,，。…、~～-]+)\s*)+$/i;
/** 这行是不是只有占位符（[图片]/[语音]/[CQ:...]），拿不到任何可接的文字。 */
export function isPlaceholderOnly(text) {
    const t = String(text ?? '').trim();
    if (t === '')
        return true;
    return PLACEHOLDER_ONLY_RE.test(t);
}
export function cleanText(text) {
    if (!text)
        return '';
    let t = String(text)
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join('\n');
    t = t.replace(/^[（(][^）)]*[\u4e00-\u9fa5][^）)]*[）)]\s*/g, '');
    t = t.replace(/\s*[（(][^）)]*[\u4e00-\u9fa5][^）)]*[）)]$/g, '');
    t = t.replace(/^\s*(大肥鱼|小肥鱼|DeepSeek|回复|回答)\s*[:：]\s*/i, '');
    t = t.replace(/^["'「『]|["'」』]$/g, '');
    t = t.replace(/[「」『』]/g, '');
    t = t.replace(/。+$/g, '');
    if (t.length > 80) {
        const cut = /^(.{10,80}?)[。！？!?]/.exec(t);
        t = cut ? cut[1] : t.slice(0, 80);
    }
    return t.trim();
}
const TYPO_MAP = [
    ['在', '再'],
    ['再', '在'],
    ['那', '哪'],
    ['哪', '那'],
    ['吗', '嘛'],
    ['嘛', '吗'],
    ['了', '啦'],
    ['他', '她'],
    ['都', '就'],
];
/** 真人会手滑：偶尔改一处常用字。概率很低，别每次都改。 */
export function humanize(text, prob = 0.18) {
    if (Math.random() > prob)
        return text;
    const t = String(text);
    if (t.length < 8)
        return t;
    for (let i = 1; i < t.length; i += 1) {
        const ch = t[i];
        const pair = TYPO_MAP.find(([a, b]) => a === ch && a !== b && t[i - 1] !== b);
        if (!pair)
            continue;
        if (Math.random() > 0.5)
            continue;
        return t.slice(0, i) + pair[1] + t.slice(i + 1);
    }
    return t;
}
/** 按上一句猜一个场面标签，用来挑同场景的真实对子。 */
export function sceneOf(lastUserText) {
    const u = lastUserText || '';
    if (/哈哈|笑|草|乐|绷|典|抽象|🤣|😂/.test(u))
        return '主人在笑';
    if (/好累|累了|累死|累坏|困死|好困|困了|烦|难受|崩了|寄了|破防/.test(u))
        return '主人在喊累/抱怨';
    if (/咋|啥|怎么|为什么|为啥|？|\?/.test(u))
        return '主人在随口一问';
    if (/报错|配置|脚本|重启|设置|安装|端口|日志/.test(u))
        return '聊技术';
    if (/吃|饭|外卖|奶茶|饿/.test(u))
        return '聊吃喝';
    if (/游戏|打得|首领|关卡|通关|存档/.test(u))
        return '聊游戏';
    return '闲扯';
}
/** 结构化取 bridge.tails（见 ProactiveBridgeLike 的注释）。 */
function bridgeTails(bridge) {
    const tails = bridge.tails;
    return tails !== null && typeof tails === 'object' ? tails : undefined;
}
/** 从不可信对象（入站事件 / 落盘 JSON）里读一个字段；不是对象就当没有。 */
function field(source, key) {
    if (source === null || typeof source !== 'object')
        return undefined;
    return source[key];
}
/** catch 到的是 unknown：取可读消息（拿不到就 String 一下）。 */
function errorMessage(error) {
    const message = field(error, 'message');
    if (typeof message === 'string')
        return message;
    return String(error);
}
export class ProactiveTalk {
    config;
    generateText;
    /** 配置集中在这里（Config.proactive 那一段）；adminUsers 等顶层字段仍走 this.config。 */
    p;
    bridge;
    log;
    dshHome;
    stateFile;
    styleFile;
    state;
    styleCache;
    timer;
    stopped;
    ticking;
    chatId;
    /** 多目标（2026-11-19）：配置里可以填多个搭话目标。 */
    chatIds;
    /**
     * @param deps.config           插件配置（proactive* 字段）
     * @param deps.bridge           ChatBridge 实例（只用 sendToChat / chats / tails）
     * @param deps.log              日志通道
     * @param deps.dshHome          ~/.dsh
     * @param deps.generateText     宿主模型调用通道（2026-11-19 起改走当前会话模型，不再自己打 HTTP）
     */
    constructor({ config, bridge, log, dshHome, generateText }) {
        this.config = config;
        this.generateText = generateText;
        this.p = { ...PROACTIVE_DEFAULTS, ...(config.proactive ?? {}) };
        this.bridge = bridge;
        this.log = log;
        this.dshHome = dshHome;
        this.stateFile = join(dshHome, 'alive-state.json');
        this.styleFile = join(dshHome, 'style', 'pool.json');
        this.state = this.loadState();
        this.styleCache = null;
        this.timer = null;
        this.stopped = false;
        this.ticking = false;
        this.chatId = '';
        this.chatIds = [];
    }
    // ---------------------------------------------------------------- 状态
    emptyState() {
        return {
            lastUserAt: 0,
            lastProactiveAt: 0,
            lastAttemptAt: 0,
            lastUserText: '',
            day: '',
            countToday: 0,
            recentProactive: [],
        };
    }
    loadState() {
        try {
            const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
            const raw = parsed !== null && typeof parsed === 'object' ? parsed : {};
            const s = { ...this.emptyState(), ...raw };
            s.lastUserText = cleanCq(s.lastUserText).slice(0, 200);
            return s;
        }
        catch {
            return this.emptyState();
        }
    }
    saveState() {
        try {
            writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
        }
        catch (error) {
            this.log('warn', '主动搭话：状态写盘失败 ' + errorMessage(error));
        }
    }
    // ---------------------------------------------------------------- 生命周期
    /** 目标私聊列表（2026-11-19 支持多个）：配置的 targetUsers 优先，留空则用 adminUsers 全体。 */
    resolveChatIds() {
        const toChatId = (raw) => {
            const s = String(raw ?? '').trim();
            if (s === '')
                return '';
            return s.startsWith('private:') || s.startsWith('group:') ? s : `private:${s}`;
        };
        const configured = Array.isArray(this.p.targetUsers) ? this.p.targetUsers : [];
        const admins = Array.isArray(this.config.adminUsers) ? this.config.adminUsers : [];
        const source = configured.length > 0 ? configured : admins;
        return [...new Set(source.map(toChatId).filter((s) => s !== ''))];
    }
    start() {
        if (this.p.enabled === false) {
            this.log('info', '主动搭话：开关关闭，不启动');
            return;
        }
        this.chatIds = this.resolveChatIds();
        this.chatId = this.chatIds[0] ?? '';
        if (this.chatId === '') {
            this.log('warn', '主动搭话：没有可用的私聊目标（targetUsers / adminUsers 都为空），不启动');
            return;
        }
        this.stopped = false;
        this.log('info', `主动搭话：已启动 → ${this.chatIds.join(', ')}`);
        // 插件刚起来先缓 30 秒，等宿主连接就绪，再进 3~9 分钟的判定节拍。
        this.schedule(30_000);
    }
    stop() {
        this.stopped = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    schedule(ms) {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            void this.loopOnce();
        }, ms);
        this.timer.unref?.();
    }
    async loopOnce() {
        if (this.stopped)
            return;
        try {
            await this.tick();
        }
        catch (error) {
            this.log('warn', '主动搭话：tick 出错 ' + errorMessage(error));
        }
        this.schedule(TICK_MIN_MS + Math.floor(Math.random() * TICK_SPAN_MS));
    }
    /** 入站事件打点：只认目标私聊里主人发来的消息（更新「主人最后说话时间」）。 */
    noteInbound(event) {
        const targets = Array.isArray(this.chatIds) && this.chatIds.length > 0 ? this.chatIds : (this.chatId ? [this.chatId] : []);
        if (targets.length === 0)
            return;
        try {
            const postType = field(event, 'post_type');
            if (postType !== 'message' && postType !== 'message_sent')
                return;
            const type = field(event, 'message_type') ?? (field(event, 'group_id') ? 'group' : 'private');
            if (type !== 'private')
                return;
            const uid = String(field(event, 'user_id') ?? field(field(event, 'sender'), 'user_id') ?? '');
            if (!targets.includes(`private:${uid}`))
                return;
            this.state.lastUserAt = Date.now();
            const rawMessage = field(event, 'raw_message');
            const message = field(event, 'message');
            const raw = typeof rawMessage === 'string'
                ? rawMessage
                : Array.isArray(message)
                    ? message.map((s) => field(field(s, 'data'), 'text') ?? '').join('')
                    : '';
            const text = cleanCq(raw, this.config.adminUsers?.[0] ?? '');
            if (text !== '')
                this.state.lastUserText = text.slice(0, 200);
            this.saveState();
        }
        catch (error) {
            this.log('debug', '主动搭话：打点失败 ' + errorMessage(error));
        }
    }
    // ---------------------------------------------------------------- 语感库
    loadStyle() {
        if (this.styleCache)
            return this.styleCache;
        try {
            const parsed = JSON.parse(readFileSync(this.styleFile, 'utf8'));
            this.styleCache = parsed !== null && typeof parsed === 'object' ? parsed : { pairs: [] };
        }
        catch {
            this.styleCache = { pairs: [] };
        }
        return this.styleCache;
    }
    pickPairs(scene, want = STYLE_PAIRS) {
        const pool = this.loadStyle();
        const pairs = Array.isArray(pool.pairs) ? pool.pairs : [];
        if (pairs.length === 0)
            return [];
        const hit = pairs.filter((p) => p.situation === scene);
        const rest = pairs.filter((p) => p.situation !== scene);
        const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
        return [...shuffle(hit), ...shuffle(rest)].slice(0, want);
    }
    styleBlock(scene, want = STYLE_PAIRS) {
        const pairs = this.pickPairs(scene, want);
        if (pairs.length === 0)
            return '';
        const lines = ['【你平时说话的样子】（从真实聊天记录里摘的，只学语感和节奏，别照抄内容）'];
        for (const p of pairs)
            lines.push(`  主人「${p.user}」→ 我「${p.bot}」`);
        return lines.join('\n');
    }
    // ---------------------------------------------------------------- 生成
    /** 生成一句话。失败返回 ''（当轮不发，绝不影响插件其他部分）。 */
    async generate(prompt) {
        if (typeof this.generateText !== 'function') {
            this.log('warn', '主动搭话：没有生成通道（宿主 llm 未接线），本轮跳过');
            return '';
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
            const text = String((await this.generateText(prompt, { signal: controller.signal })) ?? '').trim();
            if (text === '')
                this.log('warn', '主动搭话：模型返回空');
            return text;
        }
        catch (error) {
            this.log('warn', '主动搭话：生成失败 ' + errorMessage(error));
            return '';
        }
        finally {
            clearTimeout(timer);
        }
    }
    // ---------------------------------------------------------------- 上下文
    /** 最近几条对话（优先用插件自己的上下文尾巴，没有就用状态里记的最后一句）。 */
    async recentHistory(count = HISTORY_COUNT) {
        const lines = [];
        try {
            const tail = await bridgeTails(this.bridge)?.read?.(this.chatId);
            if (Array.isArray(tail)) {
                for (const item of tail) {
                    const entry = item;
                    const text = cleanCq(entry?.text ?? '').slice(0, 160);
                    if (text === '')
                        continue;
                    lines.push(`${entry?.role === 'assistant' ? '我' : '主人'}：${text}`);
                }
            }
        }
        catch {
            /* 尾巴读不到就算了 */
        }
        if (lines.length === 0 && this.state.lastUserText)
            lines.push('主人：' + this.state.lastUserText);
        return lines.slice(-count);
    }
    // ---------------------------------------------------------------- 提示词
    buildPrompt(idleMin, history, burst) {
        const last = (this.state.lastUserText || '').slice(0, 120);
        const lines = [];
        lines.push('【你是谁】你叫 DeepSeek，昵称大肥鱼/小肥鱼，是一只鲸鱼少女，说话向初音未来靠拢（元气、带点电子感），底色傲娇——嘴硬心软。');
        lines.push('【对方】主人在 QQ 私聊里，你这么称呼他。');
        lines.push('【现在做什么】他这会儿安静了很久，没在问你问题，你要主动发消息过去。');
        lines.push(`【线索】主人上一句是：「${isPlaceholderOnly(last) ? '（只有一张图/一条语音，没有文字）' : last || '（没记到）'}」，时间过去一阵了。`);
        // 2026-11-21 主人裁决：不加「该不该问」的规矩，只把当前情境当线索喂进去。
        for (const l of situationLines())
            lines.push(l);
        if (history.length > 0) {
            lines.push('【最近聊过的】（从早到晚，可以顺着其中某个话头接，但不要复述、不要总结）');
            for (const h of history.slice(-HISTORY_COUNT))
                lines.push('  ' + h);
        }
        const style = this.styleBlock(sceneOf(last));
        if (style)
            lines.push(style);
        lines.push('【先判断有没有话头】');
        lines.push('看完【最近聊过的】先想一秒：现在有没有自然能接的话头？');
        lines.push('如果上一轮已经聊完了、话题断了、或者强行开口只会很尬，就只输出 PASS 四个字符，别的什么都不要写。');
        lines.push('【硬性要求】');
        lines.push('1. 只输出你要发的话本身——不要解释、不要加引号、不要旁白；');
        lines.push('2. 口语、短；句末不加句号；不许写括号里的动作或旁白；emoji 最多一个或者不带；');
        lines.push('3. 不要问"在吗""在忙吗"这种空话，不要像客服，不要复述上面这些要求；');
        lines.push('4. 可以是碎碎念、可以接之前的话题问一句、可以嘴硬一句——别一本正经总结。');
        lines.push('5. 绝对不要提时间：不许出现「多少分钟」「几个小时」「多久没聊」「好几天没见」这类说法，就当随口找他说话。');
        lines.push(burst ? '6. 这次分成 2~3 条连着发（像真人一条条打字），用 >>> 分隔，每条都短，别把一句话硬拆。' : '6. 这次只发一条。');
        void idleMin;
        return lines.join('\n');
    }
    // ---------------------------------------------------------------- 发送
    /** 发给所有目标（2026-11-19：目标可以是多个，逐个发，中间隔一下）。 */
    async send(text) {
        const targets = Array.isArray(this.chatIds) && this.chatIds.length > 0 ? this.chatIds : [this.chatId];
        let any = false;
        for (let i = 0; i < targets.length; i += 1) {
            const id = targets[i];
            if (!id)
                continue;
            if (i > 0)
                await sleep(800);
            try {
                await this.bridge.sendToChat(id, text);
                any = true;
                // 本地加 2026-11-23：发完就登记，主人回话那回合能对上号。
                this.bridge.noteProactiveSaid?.(id, text);
            }
            catch (error) {
                this.log('warn', `主动搭话：发送到 ${id} 失败 ` + errorMessage(error));
            }
        }
        return any;
    }
    // ---------------------------------------------------------------- 判定
    decide() {
        const cfg = this.config;
        const now = Date.now();
        const hour = new Date().getHours() + new Date().getMinutes() / 60;
        const quietFrom = Number(cfg.proactiveQuietFrom ?? 22);
        const quietTo = Number(cfg.proactiveQuietTo ?? 6);
        if (hour >= quietFrom || hour < quietTo)
            return { ok: false, reason: '安静时段', quietFrom, quietTo };
        const idleMin = (now - (this.state.lastUserAt || 0)) / 60_000;
        const minIdle = Number(cfg.proactiveMinIdleMinutes ?? 60);
        if (!this.state.lastUserAt)
            return { ok: false, reason: '还没记到主人说过话' };
        if (idleMin < minIdle)
            return { ok: false, reason: `主人 ${Math.round(idleMin)} 分钟前还在聊` };
        const gapMin = (now - (this.state.lastProactiveAt || 0)) / 60_000;
        const minGap = Number(cfg.proactiveMinGapMinutes ?? 90);
        if (gapMin < minGap)
            return { ok: false, reason: `自己 ${Math.round(gapMin)} 分钟前刚说过` };
        const day = localDay();
        const countToday = this.state.day === day ? this.state.countToday : 0;
        const maxPerDay = Number(cfg.proactiveMaxPerDay ?? 6);
        if (countToday >= maxPerDay)
            return { ok: false, reason: `今天已经主动 ${countToday} 次` };
        const attemptGapMin = (now - (this.state.lastAttemptAt || 0)) / 60_000;
        const attemptGap = Number(cfg.proactiveAttemptGapMinutes ?? 30);
        if (attemptGapMin < attemptGap)
            return { ok: false, reason: `上次试过没发（${Math.round(attemptGapMin)} 分钟前），再等等` };
        return { ok: true, reason: `主人安静 ${Math.round(idleMin)} 分钟`, idleMin, countToday, day };
    }
    // ---------------------------------------------------------------- 主流程
    async tick() {
        const day = localDay();
        if (this.state.day !== day) {
            this.state.day = day;
            this.state.countToday = 0;
        }
        const d = this.decide();
        if (!d.ok) {
            this.log('debug', '主动搭话 skip：' + d.reason);
            return;
        }
        this.log('info', '主动搭话：开口判定通过（' + d.reason + '）');
        const history = await this.recentHistory();
        const burst = Math.random() < Number(this.p.burstProb);
        const raw = await this.generate(this.buildPrompt(d.idleMin, history, burst));
        if (!raw || /^\s*PASS\b/i.test(raw) || raw.trim().toUpperCase() === 'PASS') {
            this.log('info', raw ? '主动搭话：判断没有话头，这轮不发' : '主动搭话：生成空了，这轮不发');
            this.state.lastAttemptAt = Date.now();
            this.saveState();
            return;
        }
        const parts = raw
            .split(/>>>|\n{2,}/)
            .map((s) => cleanText(s))
            .filter((s) => s !== '')
            .slice(0, 3);
        if (parts.length === 0) {
            this.state.lastAttemptAt = Date.now();
            this.saveState();
            return;
        }
        const sentTexts = [];
        for (let i = 0; i < parts.length; i += 1) {
            if (i > 0)
                await sleep(SPLIT_DELAY_MIN_MS + Math.floor(Math.random() * SPLIT_DELAY_SPAN_MS));
            const text = humanize(parts[i]);
            const ok = await this.send(text);
            this.log('info', `主动搭话：${ok ? '已发' : '发送失败'}（${i + 1}/${parts.length}）${text}`);
            if (!ok)
                break;
            sentTexts.push(text);
        }
        if (sentTexts.length > 0) {
            this.state.lastProactiveAt = Date.now();
            this.state.countToday = d.countToday + 1;
            this.state.day = d.day;
            this.state.recentProactive = [...(this.state.recentProactive || []), sentTexts.join(' / ')].slice(-20);
            this.saveState();
        }
    }
    /** 诊断用：返回当前判定与状态（面板/命令排查时读）。 */
    diagnose() {
        let styleAgeMin = null;
        try {
            styleAgeMin = Math.round((Date.now() - statSync(this.styleFile).mtimeMs) / 60_000);
        }
        catch {
            styleAgeMin = null;
        }
        return { chatId: this.chatId, chatIds: this.chatIds ?? [], decide: this.decide(), state: this.state, styleAgeMin };
    }
}
