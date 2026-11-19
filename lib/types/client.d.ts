declare const window: any;
declare const document: any;
/**
 * 2026-11-19（本地加）：表情包库面板用到的浏览器侧最小接口声明。
 * 本 bundle 的 tsconfig lib 只有 ES2024（无 DOM），故在文件顶声明 / 类型收窄，
 * 避免 strict 下引入 any 或依赖 DOM lib（宿主浏览器恒有这些全局）。
 */
declare const FileReader: {
    new (): {
        result: unknown;
        onload: (() => void) | null;
        onerror: (() => void) | null;
        readAsDataURL(file: unknown): void;
    };
};
declare const IntersectionObserver: {
    new (callback: (entries: readonly {
        isIntersecting?: boolean;
        target: {
            getAttribute(name: string): string | null;
        };
    }[]) => void, options?: {
        rootMargin?: string;
    }): {
        observe(node: unknown): void;
        unobserve(node: unknown): void;
        disconnect(): void;
    };
};
/** 表情包条目（字段逐字对齐 host 侧 listStickers 的 items）。 */
interface StickerItemLike {
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
/** 表情包库统计（host snapshotOf 的 stats）。 */
interface StickerStatsLike {
    total: number;
    approved: number;
    pending: number;
    bytes: number;
    root: string;
}
/** 单张审核 / 重新识别结果（host retagStickers 的 results 元素）。 */
interface StickerResultLike {
    hash: string;
    ok: boolean;
    description?: string;
    tags?: string[];
    reason?: string;
}
/** listStickers / addSticker / approve… 的统一返回快照。 */
interface StickerSnapshotLike {
    ok: boolean;
    root: string;
    autoCollect: boolean;
    approvedDir: string;
    pendingDir: string;
    stats: StickerStatsLike;
    items: StickerItemLike[];
    error?: unknown;
    results?: StickerResultLike[];
    added?: {
        added: boolean;
        reason?: string;
        item?: StickerItemLike;
    };
    removed?: {
        hash: string;
        ok: boolean;
    }[];
}
/** readSticker 返回（dataUrl 走 MIME base64；超限只回 tooLarge）。 */
interface StickerImageLike {
    ok: boolean;
    hash: string;
    dataUrl?: string;
    bytes?: number;
    mime?: string;
    tooLarge?: boolean;
}
/** 面板用到的 remote 方法面（真身是 host remote.onebotSettings；这里只声明用到的方法）。 */
interface StickerRemoteLike {
    listStickers(): unknown;
    addSticker(name: string, dataUrl: string): unknown;
    deleteSticker(hashes: string[]): unknown;
    approveStickers(hashes: string[]): unknown;
    unapproveStickers(hashes: string[]): unknown;
    retagStickers(hashes: string[]): unknown;
    readSticker(hash: string): unknown;
    updateSticker(hash: string, patch: {
        description?: string;
        tags?: string[];
    }): unknown;
}
/** 面板里用到的最小事件形状（change / click / keydown / 上传）。 */
interface StickerPanelEvent {
    target: {
        value: string;
        files?: ArrayLike<unknown> | null;
    };
    key?: string;
    /** 2026-11-19：编辑框改成多行 textarea 后，靠 Ctrl/⌘+Enter 保存。 */
    ctrlKey?: boolean;
    metaKey?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
}
/** StickerPanel 的 props（ui 只需 Button 与 ImageLightbox 两个能力）。 */
interface StickerPanelProps {
    remote: StickerRemoteLike;
    ui: {
        Button: unknown;
        ImageLightbox?: unknown;
    };
    onNotify?: (message: string, isError?: boolean) => void;
}
