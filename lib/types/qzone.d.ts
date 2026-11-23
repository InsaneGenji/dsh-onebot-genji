import { type ProactiveLog } from './proactive.js';
/** 发说说用的配置（设置面板 → 行为 → QQ空间 那一组，宿主键名扁平 qzoneXxx）。 */
export interface QzoneSettings {
    /** 总开关：关掉就完全不建定时器。 */
    enabled: boolean;
    /** 一天最多发几条（按本地日期重置）。 */
    maxPerDay: number;
    /** 两条之间至少隔多久（分钟）。 */
    minGapMinutes: number;
    /** 安静时段起点（小时，含）——这段时间不发。 */
    quietFrom: number;
    /** 安静时段终点（小时，不含）。 */
    quietTo: number;
    /** 查看权限：public 所有人 / friends 好友 / private 仅自己（宿主存字符串，
     *  发出去时映射成 NapCat 的 ugc_right 数字）。 */
    visibility: 'public' | 'friends' | 'private';
}
/** 默认值：与 src/index.ts 的 Config schema 默认值逐项对齐。 */
export declare const QZONE_DEFAULTS: QzoneSettings;
/** 面板上的可见性字符串 → NapCat send_qzone_msg 的 ugc_right 数字。
 *  1 所有人 / 4 好友 / 64 仅自己（16、128 要 target_uins，面板上不给选）。 */
export declare function ugcRightOf(visibility: string): number;
/** 落盘状态（~/.dsh/qzone-state.json）。字段可能缺项，读进来先垫默认。 */
export interface QzoneState {
    /** 上次发出去的时间戳（毫秒）。 */
    lastPostAt: number;
    /** 本地日期，形如 2026-11-23。 */
    day: string;
    /** 当天已发条数。 */
    countToday: number;
    /** 最近发过的几条正文（避免反复说同一件事）。 */
    recentPosts: string[];
}
/** 判定结果：通过时带余量，不通过时带理由（直接进诊断日志）。 */
export type QzoneDecision = {
    ok: true;
    reason: string;
    countToday: number;
    day: string;
} | {
    ok: false;
    reason: string;
};
/** 发布通道（index.ts 注入；真身是 connection.call('send_qzone_msg')）。 */
export type QzonePublish = (content: string, ugcRight: number) => Promise<string>;
/** 构造参数。 */
export interface QzonePostDeps {
    /** 宿主配置里这个文件用到的那几项（Config.qzoneXxx）。 */
    config: Partial<QzoneSettings>;
    log: ProactiveLog;
    /** ~/.dsh */
    dshHome: string;
    /** 宿主模型调用通道（当前会话模型）。 */
    generateText?: (prompt: string, options: {
        signal?: AbortSignal;
    }) => Promise<string>;
    /** 发布通道；没接线时本轮直接跳过（fail-closed，不猜）。 */
    publish?: QzonePublish;
}
export declare class QzonePost {
    readonly log: ProactiveLog;
    readonly dshHome: string;
    readonly generateText: QzonePostDeps['generateText'];
    readonly publish: QzonePublish | undefined;
    readonly q: QzoneSettings;
    readonly stateFile: string;
    state: QzoneState;
    timer: ReturnType<typeof setTimeout> | null;
    stopped: boolean;
    ticking: boolean;
    constructor({ config, log, dshHome, generateText, publish }: QzonePostDeps);
    emptyState(): QzoneState;
    loadState(): QzoneState;
    saveState(): void;
    start(): void;
    stop(): void;
    schedule(ms: number): void;
    loopOnce(): Promise<void>;
    /** 跨天就把当天计数清零（安静的副作用：跨天那一刻顺手写盘，别攒着）。 */
    rollDay(): boolean;
    decide(now?: Date): QzoneDecision;
    buildPrompt(now?: Date): string;
    generate(prompt: string): Promise<string>;
    /** 洗一遍模型输出：去 CQ 码、去 markdown 痕迹、去掉整段包裹的引号、限长。 */
    normalize(raw: string): string;
    tick(): Promise<void>;
    /** 手动发一条（工具用；不走判定，不占自动额度）。 */
    postNow(content: string): Promise<{
        tid: string;
        text: string;
    }>;
    /** 诊断：给设置页/日志看当前门槛卡在哪。 */
    diagnose(): {
        settings: QzoneSettings;
        state: QzoneState;
        decision: QzoneDecision;
    };
}
/** 供 index.ts 复用：把状态里存的正文也当语气参考（预留，目前未用）。 */
export declare function qzoneHumanize(text: string, prob?: number): string;
