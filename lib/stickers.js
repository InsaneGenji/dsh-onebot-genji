/**
 * 表情包库（2026-11-19 从 workspace 的 startup/sticker-*.mjs 搬进插件）。
 *
 * 默认落在 ~/.dsh/dsh-onebot-genji/stickers（2026-11-19 主人指定）：
 *   stickers/index.json   索引（hash → 记录）
 *   stickers/已审核/       已审核，聊天里只从这里挑
 *   stickers/未审核/       自动收集进来的，面板里审核后才可用
 *
 * ⚠️ 插件是 git 源装的，`pnpm install` 会整只覆盖 node_modules 里那个目录，
 *    所以图库放在 .dsh 下、不跟着插件走。想放别处就改「表情包库目录」。
 *
 * 只做文件与索引；图片识别打标签由 makeStickerTagger(ctx) 提供的回调用宿主模型做。
 *
 * 2026-11-19 1:1 移植成 src/stickers.ts（严格模式 TypeScript）：只补类型，
 * 逻辑、方法划分、文案与默认值一律照抄 lib/stickers.js，本文件自包含。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { homedir } from 'node:os';
export const APPROVED_DIR_NAME = '已审核';
export const PENDING_DIR_NAME = '未审核';
/** 默认库目录：~/.dsh/dsh-onebot-genji/stickers（config.stickerRoot 留空时用它）。
 *  2026-11-19 主人指定放在 .dsh 下：插件目录会被 pnpm install 整只覆盖，图库跟着丢。 */
export const DEFAULT_STICKER_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-onebot-genji', 'stickers');
/** 老位置（2026-11-19 之前），只给一次性迁移脚本用。 */
export const LEGACY_STICKER_ROOT = 'D:\\Software\\dsh-workspace\\stickers';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const INDEX_VERSION = 2;
/** 已删除的内容指纹最多记这么多条（墓碑：删过的图不再自动收回来）。 */
const DELETED_LIMIT = 2000;
/**
 * Array.isArray() 在 `unknown` 上会把结果放宽成 `any[]`；过这个守卫拿回
 * `unknown[]`，后面靠逐字段 typeof / Number() 收窄，不引入 any。
 */
function isUnknownArray(value) {
    return Array.isArray(value);
}
/** 把 JSON 读回来的未知值当字符串键字典读（非对象一律当空字典）。 */
function asRecord(value) {
    return value != null && typeof value === 'object' ? value : {};
}
/** `String(error && error.message || error)` 的类型安全写法（取值顺序一致）。 */
function errorText(error) {
    const message = error != null && typeof error === 'object' ? error.message : undefined;
    return String(message || error);
}
/** 按文件头判定真实格式（QQ 传来的扩展名经常是错的）。 */
export function sniffImageMime(buf) {
    if (!buf || buf.length < 12)
        return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
        return 'image/gif';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d)
        return 'image/bmp';
    return null;
}
function extForMime(mime, fallback) {
    switch (mime) {
        case 'image/png': return '.png';
        case 'image/jpeg': return '.jpg';
        case 'image/gif': return '.gif';
        case 'image/webp': return '.webp';
        case 'image/bmp': return '.bmp';
        default: return (fallback || '.png').toLowerCase();
    }
}
/** 内容指纹：sha256 前 12 位（与旧 sticker-harvest 的 hash 口径一致）。 */
export function hashOf(buf) {
    return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}
function readJson(file, fallback) {
    try {
        if (!existsSync(file))
            return fallback;
        const raw = readFileSync(file, 'utf8');
        if (raw.trim() === '')
            return fallback;
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function atomicWrite(file, text) {
    const tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
}
export class StickerStore {
    root;
    approvedDir;
    pendingDir;
    indexFile;
    log;
    index;
    constructor({ root, log }) {
        const configured = typeof root === 'string' && root.trim() !== '' ? root.trim() : DEFAULT_STICKER_ROOT;
        this.root = configured;
        this.approvedDir = join(this.root, APPROVED_DIR_NAME);
        this.pendingDir = join(this.root, PENDING_DIR_NAME);
        this.indexFile = join(this.root, 'index.json');
        this.log = log ?? (() => { });
        this.index = { version: INDEX_VERSION, items: {} };
        this.ensure();
        this.normalize();
    }
    ensure() {
        for (const dir of [this.root, this.approvedDir, this.pendingDir]) {
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
        const data = readJson(this.indexFile, null);
        if (data == null) {
            this.index = { version: INDEX_VERSION, items: {} };
            this.save();
            return;
        }
        const body = asRecord(data);
        // 旧格式（workspace 的 stickers/index.json）迁移：{items:[{hash,file,dir,tags,description,...}]}
        if (isUnknownArray(body.items)) {
            const items = {};
            for (const raw of body.items) {
                const legacy = asRecord(raw);
                if (typeof legacy.hash !== 'string')
                    continue;
                const hash = legacy.hash;
                items[hash] = {
                    hash,
                    file: String(legacy.file ?? ''),
                    approved: legacy.dir !== PENDING_DIR_NAME && legacy.approved !== false,
                    tags: isUnknownArray(legacy.tags) ? legacy.tags.map(String) : [],
                    description: typeof legacy.description === 'string' ? legacy.description : '',
                    bytes: Number(legacy.bytes) || 0,
                    addedAt: Number(legacy.addedAt) > 0 ? Number(legacy.addedAt) : (Date.parse(String(legacy.addedAt)) || Date.now()),
                };
            }
            this.index = { version: INDEX_VERSION, items };
            this.save();
            return;
        }
        this.index = {
            version: INDEX_VERSION,
            items: body.items != null && typeof body.items === 'object' ? body.items : {},
            // 墓碑要跟着索引一起读回来，否则重启后删过的图又会被收回来。
            deleted: isUnknownArray(body.deleted) ? body.deleted.map(String) : [],
        };
    }
    /** 让 index 一定带 deleted 墓碑数组（老索引读进来时补上）。 */
    normalize() {
        const raw = isUnknownArray(this.index.deleted) ? this.index.deleted : [];
        this.index.deleted = raw
            .map((hash) => String(hash))
            .filter((hash) => hash !== '')
            .slice(0, DELETED_LIMIT);
    }
    /** 清空墓碑（清完之后，以前删过的图有可能又被自动收集回来）。 */
    clearDeleted() {
        const cleared = isUnknownArray(this.index.deleted) ? this.index.deleted.length : 0;
        this.index.deleted = [];
        this.save();
        return { ok: true, cleared };
    }
    save() {
        atomicWrite(this.indexFile, JSON.stringify(this.index, null, 2));
    }
    dirOf(item) {
        return item.approved ? this.approvedDir : this.pendingDir;
    }
    pathOf(item) {
        return join(this.dirOf(item), item.file);
    }
    /** 面板列表用：把记录整理成平面数组（不读图片字节）。 */
    list() {
        const out = [];
        for (const item of Object.values(this.index.items)) {
            if (item == null || typeof item.hash !== 'string')
                continue;
            const file = this.pathOf(item);
            let exists = false;
            let bytes = item.bytes || 0;
            try {
                const st = statSync(file);
                exists = st.isFile();
                bytes = st.size;
            }
            catch {
                exists = false;
            }
            out.push({
                hash: item.hash,
                file: item.file,
                approved: item.approved === true,
                dir: item.approved === true ? APPROVED_DIR_NAME : PENDING_DIR_NAME,
                tags: Array.isArray(item.tags) ? item.tags : [],
                description: item.description || '',
                bytes,
                addedAt: item.addedAt || 0,
                exists,
            });
        }
        out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        return out;
    }
    /**
     * 2026-11-19 主人反馈：未审核里出现「裂图」——索引里有条目、磁盘上文件却没了，
     * 面板只知道读图失败，一直显示「…」。打开面板前先清一遍：文件不在就从索引里摘掉。
     *
     * @returns 被摘掉的 hash 列表（空表示索引是干净的）
     */
    pruneMissing() {
        const known = Object.keys(this.index.items).length;
        const gone = [];
        for (const [hash, item] of Object.entries(this.index.items)) {
            if (item == null || typeof item.hash !== 'string') {
                delete this.index.items[hash];
                gone.push(hash);
                continue;
            }
            let present = false;
            try {
                present = statSync(this.pathOf(item)).isFile();
            }
            catch {
                present = false;
            }
            if (present)
                continue;
            delete this.index.items[hash];
            gone.push(item.hash);
        }
        // 2026-11-19 事故：库里 188 条一起被判「文件丢失」，索引被整个清空（图片其实还在）。
        // 一次摘掉一半以上还不少于 10 条，说明不是个别文件丢失，而是目录本身读不到
        // （盘符没挂、目录被挪、权限变动）。这种情况宁可留着让面板显示「文件丢失」。
        if (gone.length >= 10 && gone.length * 2 > known && known > 0) {
            this.ensure();
            this.log('warn', `pruneMissing 跳过：${known} 条里有 ${gone.length} 条读不到文件，按库目录整体不可用处理，索引保持原样`);
            return [];
        }
        if (gone.length > 0)
            this.save();
        return gone;
    }
    stats() {
        const items = this.list();
        let approved = 0;
        let pending = 0;
        let bytes = 0;
        for (const item of items) {
            if (item.approved)
                approved += 1;
            else
                pending += 1;
            bytes += item.bytes;
        }
        return {
            total: items.length,
            approved,
            pending,
            bytes,
            root: this.root,
            deleted: isUnknownArray(this.index.deleted) ? this.index.deleted.length : 0,
        };
    }
    /** 落一张图进库；返回 { added, item }（同内容已存在时 added=false）。 */
    addBuffer(buf, name, { approved = false, force = false } = {}) {
        if (!Buffer.isBuffer(buf) || buf.length === 0)
            return { added: false, reason: 'empty' };
        const mime = sniffImageMime(buf);
        if (mime == null)
            return { added: false, reason: 'not-image' };
        const hash = hashOf(buf);
        // 删过的图别再自动收回来（2026-11-19 主人报的 bug：删了又出现在未审核里）。
        // 但主人在面板上手动「新增」就是明确要把这张收回来，force 时先撤墓碑再入库。
        if (!force && Array.isArray(this.index.deleted) && this.index.deleted.includes(hash))
            return { added: false, reason: 'deleted' };
        if (force && Array.isArray(this.index.deleted) && this.index.deleted.includes(hash))
            this.index.deleted = this.index.deleted.filter((one) => one !== hash);
        const exist = this.index.items[hash];
        if (exist != null) {
            // 已审核的图再次被收集：不动它，免得把审核状态打回未审核
            return { added: false, reason: 'duplicate', item: this.itemView(exist) };
        }
        const ext = extForMime(mime, extname(name || ''));
        const file = hash + ext;
        const target = join(approved ? this.approvedDir : this.pendingDir, file);
        try {
            writeFileSync(target, buf);
        }
        catch (error) {
            this.log('warn', '表情包落盘失败: ' + errorText(error));
            return { added: false, reason: 'write-failed' };
        }
        const item = {
            hash,
            file,
            approved: approved === true,
            tags: [],
            description: '',
            bytes: buf.length,
            addedAt: Date.now(),
        };
        this.index.items[hash] = item;
        this.save();
        return { added: true, item: this.itemView(item) };
    }
    addFile(path, options) {
        try {
            return this.addBuffer(readFileSync(path), basename(path), options);
        }
        catch (error) {
            return { added: false, reason: 'read-failed: ' + errorText(error) };
        }
    }
    itemView(item) {
        return {
            hash: item.hash,
            file: item.file,
            approved: item.approved === true,
            dir: item.approved === true ? APPROVED_DIR_NAME : PENDING_DIR_NAME,
            tags: item.tags || [],
            description: item.description || '',
            bytes: item.bytes || 0,
            addedAt: item.addedAt || 0,
            exists: true,
        };
    }
    /** 读一帧给面板做缩略图：返回 data URL（超过 maxBytes 直接放弃，别把面板撑爆）。 */
    readImage(hash, maxBytes = 2_000_000) {
        const item = this.index.items[hash];
        if (item == null)
            return null;
        const file = this.pathOf(item);
        let buf;
        try {
            const st = statSync(file);
            if (st.size > maxBytes)
                return { tooLarge: true, bytes: st.size, mime: null };
            buf = readFileSync(file);
        }
        catch {
            return null;
        }
        const mime = sniffImageMime(buf) || 'image/png';
        return { dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length, mime };
    }
    remove(hash) {
        const item = this.index.items[hash];
        if (item == null)
            return { ok: false, reason: 'not-found' };
        const file = this.pathOf(item);
        try {
            if (existsSync(file))
                unlinkSync(file);
        }
        catch (error) {
            return { ok: false, reason: 'unlink-failed: ' + errorText(error) };
        }
        delete this.index.items[hash];
        // 墓碑：记下内容指纹，自动收集时直接跳过，免得删掉的图又被收回未审核。
        const deleted = isUnknownArray(this.index.deleted) ? this.index.deleted : [];
        this.index.deleted = [hash, ...deleted.filter((one) => one !== hash)].slice(0, DELETED_LIMIT);
        this.save();
        return { ok: true };
    }
    /** 把一条记录从一个目录搬到另一个（审核通过 / 撤回）。 */
    moveTo(item, approved) {
        const from = this.pathOf(item);
        const to = join(approved ? this.approvedDir : this.pendingDir, item.file);
        if (from !== to) {
            try {
                renameSync(from, to);
            }
            catch {
                try {
                    writeFileSync(to, readFileSync(from));
                    unlinkSync(from);
                }
                catch {
                    return false;
                }
            }
        }
        item.approved = approved;
        return true;
    }
    /**
     * 审核：打标签 + 移进已审核目录。
     * @param hashes 要审核的 hash 数组（空数组 = 全部未审核）
     * @param tagger async (filePath) => { description, tags } | null
     */
    async approve(hashes, tagger) {
        const targets = (Array.isArray(hashes) && hashes.length > 0)
            ? hashes.map((h) => this.index.items[h]).filter((item) => item != null)
            : Object.values(this.index.items).filter((item) => item != null && item.approved !== true);
        const results = [];
        for (const item of targets) {
            const file = this.pathOf(item);
            let tagged = null;
            if (typeof tagger === 'function') {
                try {
                    tagged = await tagger(file);
                }
                catch (error) {
                    this.log('warn', '表情包识别失败（' + item.hash + '）: ' + errorText(error));
                    tagged = null;
                }
            }
            if (tagged != null) {
                if (typeof tagged.description === 'string' && tagged.description.trim() !== '')
                    item.description = tagged.description.trim();
                if (Array.isArray(tagged.tags)) {
                    const merged = [];
                    for (const tag of tagged.tags) {
                        const text = String(tag).trim();
                        if (text !== '' && !merged.includes(text))
                            merged.push(text);
                    }
                    if (merged.length > 0)
                        item.tags = merged.slice(0, 8);
                }
            }
            const moved = this.moveTo(item, true);
            results.push({ hash: item.hash, ok: moved, description: item.description, tags: item.tags });
        }
        this.save();
        return results;
    }
    /**
     * 重新识别：只重跑识别，更新描述与标签；不动审核状态、不搬目录（2026-11-19 主人要求）。
     * @param hashes 要重新识别的 hash 数组
     * @param tagger async (filePath) => { description, tags } | null
     */
    async retag(hashes, tagger) {
        const out = [];
        const list = Array.isArray(hashes) ? hashes : [hashes];
        for (const hash of list) {
            const item = this.index.items[hash];
            if (item == null) {
                out.push({ hash: String(hash), ok: false, reason: 'not-found' });
                continue;
            }
            if (typeof tagger !== 'function') {
                out.push({ hash: String(hash), ok: false, reason: 'no-tagger' });
                continue;
            }
            let tagged = null;
            try {
                tagged = await tagger(this.pathOf(item));
            }
            catch (error) {
                this.log('warn', '表情包重新识别失败（' + hash + '）: ' + errorText(error));
                tagged = null;
            }
            if (tagged == null) {
                out.push({ hash: String(hash), ok: false, reason: 'no-result', description: item.description, tags: item.tags });
                continue;
            }
            if (typeof tagged.description === 'string' && tagged.description.trim() !== '')
                item.description = tagged.description.trim();
            if (Array.isArray(tagged.tags)) {
                const merged = [];
                for (const tag of tagged.tags) {
                    const text = String(tag).trim();
                    if (text !== '' && !merged.includes(text))
                        merged.push(text);
                }
                if (merged.length > 0)
                    item.tags = merged.slice(0, 8);
            }
            out.push({ hash: String(hash), ok: true, description: item.description, tags: item.tags });
        }
        this.save();
        return out;
    }
    /**
     * 手动改描述 / 标签（2026-11-19 主人要求）：只改索引里的字段，不动文件、不动审核状态。
     * @param hash 目标图
     * @param patch { description?: string, tags?: string[] }
     */
    update(hash, patch) {
        const item = this.index.items[hash];
        if (item == null)
            return { hash: String(hash), ok: false, reason: 'not-found' };
        const body = patch ?? {};
        if (Object.prototype.hasOwnProperty.call(body, 'description')) {
            const text = String(body.description ?? '').trim();
            if (text === '')
                delete item.description;
            else
                item.description = text.slice(0, 200);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
            const list = Array.isArray(body.tags) ? body.tags : [];
            const merged = [];
            for (const tag of list) {
                const text = String(tag ?? '').trim();
                if (text !== '' && !merged.includes(text) && merged.length < 8)
                    merged.push(text);
            }
            item.tags = merged;
        }
        this.save();
        return { hash: String(hash), ok: true, description: item.description, tags: item.tags };
    }
    /** 撤回审核：搬回未审核（标签保留）。 */
    unapprove(hashes) {
        const out = [];
        for (const hash of Array.isArray(hashes) ? hashes : []) {
            const item = this.index.items[hash];
            if (item == null)
                continue;
            out.push({ hash, ok: this.moveTo(item, false) });
        }
        this.save();
        return out;
    }
    /**
     * 从 QQ 媒体目录自动收集新图（只收图片，内容去重，全部进未审核）。
     * @returns {{ scanned: number, added: number, items: object[] }}
     */
    collect(mediaDir) {
        let names = [];
        try {
            names = readdirSync(mediaDir);
        }
        catch {
            return { scanned: 0, added: 0, items: [] };
        }
        let scanned = 0;
        let added = 0;
        const items = [];
        for (const name of names) {
            const ext = extname(name).toLowerCase();
            if (!IMAGE_EXTS.has(ext))
                continue;
            const full = join(mediaDir, name);
            let buf;
            try {
                const st = statSync(full);
                if (!st.isFile() || st.size < 1024)
                    continue;
                buf = readFileSync(full);
            }
            catch {
                continue;
            }
            scanned += 1;
            const result = this.addBuffer(buf, name, { approved: false });
            if (result.added) {
                added += 1;
                items.push(result.item);
            }
        }
        return { scanned, added, items };
    }
    /** 把一批目录里的图片全部导入（一次性迁移用）。 */
    importDirs(dirs, { approved = true } = {}) {
        let imported = 0;
        let skipped = 0;
        for (const dir of dirs) {
            let names = [];
            try {
                names = readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const name of names) {
                const ext = extname(name).toLowerCase();
                if (!IMAGE_EXTS.has(ext))
                    continue;
                const result = this.addFile(join(dir, name), { approved });
                if (result.added)
                    imported += 1;
                else
                    skipped += 1;
            }
        }
        return { imported, skipped };
    }
}
/* ------------------------------------------------------------------ *
 * 审核时的图片识别：走宿主当前模型（ctx.llm + ctx.attachments）
 * ------------------------------------------------------------------ */
// 2026-11-19：会话 source 写入形态必须走 producer-owned kind，抽成常量便于静态审计。
const TAG_MESSAGE_SOURCE = { kind: 'dsh-onebot-sticker-tag' };
const TAGGING_PROMPT = [
    '你是表情包库的编目员。看这张图，用简体中文给出它的编目信息。',
    '',
    '1) description：一句话说画面——谁、在干什么、什么情绪/表情。不超过 40 字。',
    '   如果是梗图，把梗的意思也点出来（例如「无语翻白眼」「拍桌大笑」「求饶哭」）。',
    '   不要写「这是一张图片」这种废话，也不要把图上的字逐字念出来。',
    '2) tags：3~6 个短标签，中文，名词或情绪词（例如：猫、无语、Q版、得意、喝茶）。',
    '',
    '只输出一行 JSON，不要解释、不要代码块：',
    '{"description":"...","tags":["...","..."]}',
].join('\n');
function parseTaggingReply(text) {
    if (typeof text !== 'string')
        return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    let data;
    try {
        data = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    const tags = isUnknownArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : [];
    if (description === '' && tags.length === 0)
        return null;
    return { description, tags };
}
/** 从宿主 ctx 取一格服务：先走 ctx.get（cordis 正规入口，插件没 inject 也取得到），
 *  再回落属性访问（测试替身 / 老宿主）。 */
function hostService(ctx, key) {
    if (ctx == null || typeof ctx !== 'object')
        return undefined;
    const getter = ctx.get;
    if (typeof getter === 'function') {
        try {
            const value = getter.call(ctx, key);
            if (value !== undefined && value !== null)
                return value;
        }
        catch {
            /* 取不到就当没有，走属性回落 */
        }
    }
    const fallback = ctx[key];
    return fallback === undefined || fallback === null ? undefined : fallback;
}
/**
 * 造一个审核用的识别器：把图作为 image block 交给宿主当前会话模型，拿回
 * {description, tags}。任一环节不可用（没 attachments / 模型不认图 / 超时）都返回 null，
 * 审核照常通过，只是没标签——不阻塞流程。
 *
 * @param ctx 插件 ctx（需要 llm / agentDefaultModel / attachments）
 * @param options.log 日志函数
 */
export function makeStickerTagger(ctx, { log } = {}) {
    let dshLlm = null;
    const logFn = log ?? (() => { });
    return async function tagger(filePath) {
        let buf;
        try {
            buf = readFileSync(filePath);
        }
        catch {
            logFn('warn', '表情包识别跳过：文件读不到 ' + filePath);
            return null;
        }
        if (buf.length === 0 || buf.length > 8 * 1024 * 1024) {
            logFn('warn', '表情包识别跳过：字节数不合规 ' + buf.length + ' ' + filePath);
            return null;
        }
        const mime = sniffImageMime(buf);
        if (mime == null || mime === 'image/bmp') {
            logFn('warn', '表情包识别跳过：认不出图片类型 ' + String(mime) + ' ' + filePath);
            return null; // 附件服务只收 png/jpeg/webp/gif
        }
        const attachments = hostService(ctx, 'attachments');
        const agentDefaultModel = hostService(ctx, 'agentDefaultModel');
        const llm = hostService(ctx, 'llm');
        if (attachments == null || llm == null || agentDefaultModel == null) {
            logFn('debug', '表情包识别跳过：宿主缺 attachments/llm/agentDefaultModel');
            return null;
        }
        if (dshLlm == null) {
            try {
                dshLlm = await import('@deepseek-ai/dsh-llm');
            }
            catch (error) {
                logFn('warn', '表情包识别不可用（dsh-llm 解析失败）: ' + errorText(error));
                return null;
            }
        }
        let refs;
        try {
            refs = await attachments.saveImages([{ data: buf, mediaType: mime, name: basename(filePath) }]);
        }
        catch (error) {
            logFn('warn', '表情包识别：图片入库失败 ' + errorText(error));
            return null;
        }
        const ref = isUnknownArray(refs) ? refs[0] : null;
        if (ref == null) {
            logFn('warn', '表情包识别跳过：附件入库没有返回引用 ' + filePath);
            return null;
        }
        const selection = agentDefaultModel.currentSelection();
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(90_000)
            : undefined;
        try {
            const call = await llm.prepareCall({
                provider: selection.provider,
                model: selection.model,
                maxTokens: 600,
            }, signal, (controls) => controls);
            const message = dshLlm.createUserMessage({
                content: [
                    { type: 'text', text: TAGGING_PROMPT },
                    { type: 'image', attachment: ref },
                ],
                source: TAG_MESSAGE_SOURCE,
            });
            const assembler = new dshLlm.BlockAssembler();
            for await (const chunk of call.stream({
                ...call.config,
                messages: [message],
                purpose: 'dsh-onebot-sticker-tag',
                signal,
            }))
                assembler.push(chunk);
            const blocks = assembler.blocks();
            const text = blocks.filter((b) => b != null && b.type === 'text').map((b) => String(b.text ?? '')).join('').trim();
            const parsed = parseTaggingReply(text);
            // 2026-11-19：解析失败以前是静默 null，面板只看到 no-result、日志里啥也没有。
            // 现在把模型原文写进日志（前 400 字），下次一眼能看出是拒答、纯文本还是格式跑偏。
            if (parsed == null)
                logFn('warn', '表情包识别：模型没给出可解析的 JSON（原文 ' + text.length + ' 字）: ' + text.slice(0, 400));
            return parsed;
        }
        catch (error) {
            logFn('warn', '表情包识别失败: ' + errorText(error));
            return null;
        }
    };
}
