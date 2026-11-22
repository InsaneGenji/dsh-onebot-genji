/** 日志通道：与 lib/prompt.ts 的 ChannelLog 同形，但不 import 它（自包含）。 */
export type ProactiveLogLevel = 'info' | 'warn' | 'error' | 'debug';
export type ProactiveLog = (level: ProactiveLogLevel, message: string) => void;
/** 主动搭话的开关与门槛（设置面板 → 行为 → 私聊 那一组）。 */
export interface ProactiveSettings {
    enabled: boolean;
    targetUsers: string[];
    minIdleMinutes: number;
    minGapMinutes: number;
    maxPerDay: number;
    quietFrom: number;
    quietTo: number;
    attemptGapMinutes: number;
    burstProb: number;
}
/** 配置默认值：Config.proactive 用 .default({}) 时不保证补齐子字段，这里垫一层，
 *  免得 undefined 把阈值判断打成恒假、让主动搭话静默失效。与 lib/index.js 的
 *  Config.proactive 逐项对齐（不含接口地址/模型名/Key —— 2026-11-19 起走当前会话模型）。 */
export declare const PROACTIVE_DEFAULTS: ProactiveSettings;
/** 现在几点（HH:MM），给搭话当线索用。 */
export declare function clockOf(date?: Date): string;
/** 这台机器开机多久了（分钟）。2026-11-21 主人要求：把这事实当线索喂进去——
 *  早上八点能跑，本身就说明他昨晚关过机、现在又开回来了，不该再问「关了没」。 */
export declare function uptimeMinutes(): number;
/** 情境线索：现在是几点、机器刚开机还是已经开了一整天。
 *  只给事实，不给「该不该问关了没」这种规矩。 */
export declare function situationLines(now?: Date, bootMin?: number): string[];
/** 把 NapCat 的 raw_message 里那堆 CQ 码压成中文占位，不然生成时接不上话头。 */
export declare function cleanCq(text: unknown, masterQQ?: string): string;
/** 这行是不是只有占位符（[图片]/[语音]/[CQ:...]），拿不到任何可接的文字。 */
export declare function isPlaceholderOnly(text: unknown): boolean;
export declare function cleanText(text: unknown): string;
/** 真人会手滑：偶尔改一处常用字。概率很低，别每次都改。 */
export declare function humanize(text: string, prob?: number): string;
/** 按上一句猜一个场面标签，用来挑同场景的真实对子。 */
export declare function sceneOf(lastUserText: string): string;
/** 落盘状态（~/.dsh/alive-state.json）。字段来自文件，可能缺项或脏，读进来先垫默认。 */
export interface ProactiveState {
    lastUserAt: number;
    lastProactiveAt: number;
    lastAttemptAt: number;
    lastUserText: string;
    day: string;
    countToday: number;
    recentProactive: string[];
}
/** 语感库（~/.dsh/style/pool.json）里的一对「主人说 → 我回」。 */
export interface ProactiveStylePair {
    situation: string;
    user: string;
    bot: string;
}
/** 语感库文件形状：只有 pairs 有用，别的字段照旧不管。 */
export interface ProactiveStylePool {
    pairs: ProactiveStylePair[];
}
/** 判定结果：通过时带余量数字，不通过时带理由（诊断日志直接用 reason）。 */
export type ProactiveDecision = {
    ok: true;
    reason: string;
    idleMin: number;
    countToday: number;
    day: string;
} | {
    ok: false;
    reason: string;
    quietFrom?: number;
    quietTo?: number;
};
/** 宿主配置里这个文件用到的那几项（结构化描述，不 import index.ts 的 Config）。 */
export interface ProactiveHostConfig {
    /** 主动搭话那一段（Config.proactive）。 */
    proactive?: Partial<ProactiveSettings>;
    /** 管理员 QQ 列表：targetUsers 留空时作为兜底目标。 */
    adminUsers?: readonly string[];
    /** 下面几项旧字段名在 Config 里并不存在，保留是为了不改动判定逻辑（1:1 移植）。 */
    proactiveQuietFrom?: number;
    proactiveQuietTo?: number;
    proactiveMinIdleMinutes?: number;
    proactiveMinGapMinutes?: number;
    proactiveMaxPerDay?: number;
    proactiveAttemptGapMinutes?: number;
}
/** 上下文尾巴（bridge.tails）：只用到 read(chatId)。 */
export interface ProactiveTailsLike {
    read?: (chatId: string) => unknown;
}
/** ChatBridge 里这个类用到的那两个口子。
 *  tails 在 ChatBridge 上是 **private** 字段：接口里一旦声明同名的公开属性，
 *  ChatBridge 就不再满足这个接口（私有成员两边都得私有），所以这里只收
 *  sendToChat，尾巴用下面的 bridgeTails() 按名字取（运行时行为不变）。 */
export interface ProactiveBridgeLike {
    sendToChat: (chatId: string, text: string) => unknown;
}
/** 宿主模型调用通道（index.ts 注入；返回值当纯文本用）。 */
export type ProactiveGenerateText = (prompt: string, options: {
    signal?: AbortSignal;
}) => Promise<string>;
/** 构造参数（沿用 JS 版的对象解构）。 */
export interface ProactiveTalkDeps {
    /** 插件配置（proactive* 字段）。 */
    config: ProactiveHostConfig;
    /** ChatBridge 实例（只用 sendToChat / chats / tails）。 */
    bridge: ProactiveBridgeLike;
    log: ProactiveLog;
    /** ~/.dsh */
    dshHome: string;
    /** 宿主模型调用通道（2026-11-19 起改走当前会话模型，不再自己打 HTTP）。 */
    generateText?: ProactiveGenerateText;
}
export declare class ProactiveTalk {
    readonly config: ProactiveHostConfig;
    readonly generateText: ProactiveGenerateText | undefined;
    /** 配置集中在这里（Config.proactive 那一段）；adminUsers 等顶层字段仍走 this.config。 */
    readonly p: ProactiveSettings;
    readonly bridge: ProactiveBridgeLike;
    readonly log: ProactiveLog;
    readonly dshHome: string;
    readonly stateFile: string;
    readonly styleFile: string;
    state: ProactiveState;
    styleCache: ProactiveStylePool | null;
    timer: ReturnType<typeof setTimeout> | null;
    stopped: boolean;
    ticking: boolean;
    chatId: string;
    /** 多目标（2026-11-19）：配置里可以填多个搭话目标。 */
    chatIds: string[];
    /**
     * @param deps.config           插件配置（proactive* 字段）
     * @param deps.bridge           ChatBridge 实例（只用 sendToChat / chats / tails）
     * @param deps.log              日志通道
     * @param deps.dshHome          ~/.dsh
     * @param deps.generateText     宿主模型调用通道（2026-11-19 起改走当前会话模型，不再自己打 HTTP）
     */
    constructor({ config, bridge, log, dshHome, generateText }: ProactiveTalkDeps);
    emptyState(): ProactiveState;
    loadState(): ProactiveState;
    saveState(): void;
    /** 目标私聊列表（2026-11-19 支持多个）：配置的 targetUsers 优先，留空则用 adminUsers 全体。 */
    resolveChatIds(): string[];
    start(): void;
    stop(): void;
    schedule(ms: number): void;
    loopOnce(): Promise<void>;
    /** 入站事件打点：只认目标私聊里主人发来的消息（更新「主人最后说话时间」）。 */
    noteInbound(event: unknown): void;
    loadStyle(): ProactiveStylePool;
    pickPairs(scene: string, want?: number): ProactiveStylePair[];
    styleBlock(scene: string, want?: number): string;
    /** 生成一句话。失败返回 ''（当轮不发，绝不影响插件其他部分）。 */
    generate(prompt: string): Promise<string>;
    /** 最近几条对话（优先用插件自己的上下文尾巴，没有就用状态里记的最后一句）。 */
    recentHistory(count?: number): Promise<string[]>;
    buildPrompt(idleMin: number, history: readonly string[], burst: boolean): string;
    /** 发给所有目标（2026-11-19：目标可以是多个，逐个发，中间隔一下）。 */
    send(text: string): Promise<boolean>;
    decide(): ProactiveDecision;
    tick(): Promise<void>;
    /** 诊断用：返回当前判定与状态（面板/命令排查时读）。 */
    diagnose(): {
        chatId: string;
        chatIds: string[];
        decide: ProactiveDecision;
        state: ProactiveState;
        styleAgeMin: number | null;
    };
}
