export declare const APPROVED_DIR_NAME = "\u5DF2\u5BA1\u6838";
export declare const PENDING_DIR_NAME = "\u672A\u5BA1\u6838";
/** 默认库目录：~/.dsh/dsh-onebot-genji/stickers（config.stickerRoot 留空时用它）。
 *  2026-11-19 主人指定放在 .dsh 下：插件目录会被 pnpm install 整只覆盖，图库跟着丢。 */
export declare const DEFAULT_STICKER_ROOT: string;
/** 老位置（2026-11-19 之前），只给一次性迁移脚本用。 */
export declare const LEGACY_STICKER_ROOT = "D:\\Software\\dsh-workspace\\stickers";
/** 按文件头判定出来的图片 MIME（QQ 传来的扩展名经常是错的，见 sniffImageMime）。 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';
/** 索引里的一条记录。老索引缺字段，所以除 hash/file/approved 外都按可选读入。 */
export interface StickerRecord {
    hash: string;
    file: string;
    approved: boolean;
    tags?: string[];
    description?: string;
    bytes?: number;
    addedAt?: number;
}
/** index.json 的内存形态：items 是 hash → 记录；deleted 是墓碑指纹。 */
export interface StickerIndex {
    version: number;
    items: Record<string, StickerRecord | undefined>;
    deleted?: string[];
}
/** 面板列表项（list() / itemView() 的输出形状）。 */
export interface StickerItemView {
    hash: string;
    file: string;
    approved: boolean;
    dir: string;
    tags: string[];
    description: string;
    bytes: number;
    addedAt: number;
    exists: boolean;
}
/** 落盘结果：added=true 才有 item。 */
export type StickerAddResult = {
    added: true;
    item: StickerItemView;
} | {
    added: false;
    reason: string;
    item?: StickerItemView;
};
/** readImage() 的输出：要么 data URL，要么「太大不给」。 */
export type StickerImageView = {
    tooLarge: true;
    bytes: number;
    mime: null;
} | {
    dataUrl: string;
    bytes: number;
    mime: string;
};
/** stats() 的汇总数字。 */
export interface StickerStats {
    total: number;
    approved: number;
    pending: number;
    bytes: number;
    root: string;
    deleted: number;
}
/** 识别器返回的编目信息（字段可能缺，调用方逐项校验）。 */
export interface StickerTag {
    description?: string;
    tags?: string[];
}
/** 审核用的识别器：文件路径 → 编目信息（拿不到就 null）。 */
export type StickerTagger = (filePath: string) => Promise<StickerTag | null>;
/** 日志函数（宿主 ctx 的 log 形态）。 */
export type StickerLogFn = (level: string, message: string) => void;
/** approve / retag / update 的单条结果。 */
export interface StickerTagResult {
    hash: string;
    ok: boolean;
    reason?: string;
    description?: string;
    tags?: string[];
}
/** unapprove 的单条结果。 */
export interface StickerMoveResult {
    hash: string;
    ok: boolean;
}
/** remove() 的结果。 */
export type StickerRemoveResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** clearDeleted() 的结果。 */
export interface StickerClearDeletedResult {
    ok: true;
    cleared: number;
}
/** collect() 的结果。 */
export interface StickerCollectResult {
    scanned: number;
    added: number;
    items: StickerItemView[];
}
/** importDirs() 的结果。 */
export interface StickerImportResult {
    imported: number;
    skipped: number;
}
/** 手动改描述 / 标签的 patch。 */
export interface StickerPatch {
    description?: string | null;
    tags?: readonly string[] | null;
}
/** 构造参数（root 留空就用默认库目录）。 */
export interface StickerStoreOptions {
    root?: string | null;
    log?: StickerLogFn;
}
/** 按文件头判定真实格式（QQ 传来的扩展名经常是错的）。 */
export declare function sniffImageMime(buf: Buffer | null | undefined): ImageMime | null;
/** 内容指纹：sha256 前 12 位（与旧 sticker-harvest 的 hash 口径一致）。 */
export declare function hashOf(buf: Buffer | Uint8Array | string): string;
export declare class StickerStore {
    readonly root: string;
    readonly approvedDir: string;
    readonly pendingDir: string;
    readonly indexFile: string;
    private readonly log;
    private index;
    constructor({ root, log }: StickerStoreOptions);
    ensure(): void;
    /**
     * 2026-11-23 主人报的 bug：新图已经落到「未审核」、索引也写了，面板点「刷新」
     * 还是只显示 2 张。
     *
     * 根因：面板走 settings-remote 里的 `storeOf()`，那个 StickerStore 实例被缓存了
     * （root 不变就一直复用），`ensure()` 只在构造时读过一次 index.json。自动收集跑在
     * 插件主实例里、写的是磁盘，面板这位手里还是启动时那份内存快照，`list()` /
     * `stats()` 全从内存出 —— 所以刷新按钮拉到的还是旧数据。
     *
     * 修法：刷新时强制从磁盘重读一遍索引。读失败保持原内存不动（不让一次坏 JSON
     * 把面板清空）。
     */
    reload(): void;
    /** 让 index 一定带 deleted 墓碑数组（老索引读进来时补上）。 */
    normalize(): void;
    /** 清空墓碑（清完之后，以前删过的图有可能又被自动收集回来）。 */
    clearDeleted(): StickerClearDeletedResult;
    save(): void;
    dirOf(item: StickerRecord): string;
    pathOf(item: StickerRecord): string;
    /** 2026-11-23 本地加：按文件名拼「已审核」目录下的绝对路径。
     *  表情包标签只从这里挑图（未审核的不进聊天），所以不用先拿到记录。 */
    approvedPathOf(file: string): string;
    /** 面板列表用：把记录整理成平面数组（不读图片字节）。 */
    list(): StickerItemView[];
    /**
     * 2026-11-19 主人反馈：未审核里出现「裂图」——索引里有条目、磁盘上文件却没了，
     * 面板只知道读图失败，一直显示「…」。打开面板前先清一遍：文件不在就从索引里摘掉。
     *
     * @returns 被摘掉的 hash 列表（空表示索引是干净的）
     */
    pruneMissing(): string[];
    stats(): StickerStats;
    /** 落一张图进库；返回 { added, item }（同内容已存在时 added=false）。 */
    addBuffer(buf: unknown, name: string, { approved, force }?: {
        approved?: boolean;
        force?: boolean;
    }): StickerAddResult;
    addFile(path: string, options?: {
        approved?: boolean;
        force?: boolean;
    }): StickerAddResult;
    itemView(item: StickerRecord): StickerItemView;
    /** 读一帧给面板做缩略图：返回 data URL（超过 maxBytes 直接放弃，别把面板撑爆）。 */
    readImage(hash: string, maxBytes?: number): StickerImageView | null;
    remove(hash: string): StickerRemoveResult;
    /** 把一条记录从一个目录搬到另一个（审核通过 / 撤回）。 */
    moveTo(item: StickerRecord, approved: boolean): boolean;
    /**
     * 审核：打标签 + 移进已审核目录。
     * @param hashes 要审核的 hash 数组（空数组 = 全部未审核）
     * @param tagger async (filePath) => { description, tags } | null
     */
    approve(hashes: string[] | null | undefined, tagger?: StickerTagger | null): Promise<StickerTagResult[]>;
    /**
     * 重新识别：只重跑识别，更新描述与标签；不动审核状态、不搬目录（2026-11-19 主人要求）。
     * @param hashes 要重新识别的 hash 数组
     * @param tagger async (filePath) => { description, tags } | null
     */
    retag(hashes: string | string[], tagger?: StickerTagger | null): Promise<StickerTagResult[]>;
    /**
     * 手动改描述 / 标签（2026-11-19 主人要求）：只改索引里的字段，不动文件、不动审核状态。
     * @param hash 目标图
     * @param patch { description?: string, tags?: string[] }
     */
    update(hash: string, patch: StickerPatch | null | undefined): StickerTagResult;
    /** 撤回审核：搬回未审核（标签保留）。 */
    unapprove(hashes: string[] | null | undefined): StickerMoveResult[];
    /**
     * 从 QQ 媒体目录自动收集新图（只收图片，内容去重，全部进未审核）。
     * @returns {{ scanned: number, added: number, items: object[] }}
     */
    collect(mediaDir: string): StickerCollectResult;
    /** 把一批目录里的图片全部导入（一次性迁移用）。 */
    importDirs(dirs: readonly string[], { approved }?: {
        approved?: boolean;
    }): StickerImportResult;
}
/**
 * 造一个审核用的识别器：把图作为 image block 交给宿主当前会话模型，拿回
 * {description, tags}。任一环节不可用（没 attachments / 模型不认图 / 超时）都返回 null，
 * 审核照常通过，只是没标签——不阻塞流程。
 *
 * @param ctx 插件 ctx（需要 llm / agentDefaultModel / attachments）
 * @param options.log 日志函数
 */
export declare function makeStickerTagger(ctx: unknown, { log }?: {
    log?: StickerLogFn;
}): StickerTagger;
