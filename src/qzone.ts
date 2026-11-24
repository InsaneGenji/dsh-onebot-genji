/**
 * QQ 空间说说（本地加 2026-11-23，主人要求）。
 *
 * 为什么单独一个文件：跟 proactive.ts 一样自包含——只碰 node:fs / node:path，
 * 生成走宿主注入的 generateText，发布走宿主注入的 publish（内部其实是
 * OneBotConnection.call('send_qzone_msg')），不 import bridge / connection，
 * 免得那几处改动把它带崩。
 *
 * 跟主动搭话的区别：
 *   - 搭话发私聊，这里发的是公开可见的 QQ 空间说说，所以默认阈值更保守
 *     （一天 2 条、间隔至少 4 小时、凌晨安静时段不发）；
 *   - 内容不是「接话」，是「今天发生的事 + 此刻心情」，所以提示词让模型写成
 *     一段自言自语，别像 AI 宣传稿。
 *
 * 状态文件 ~/.dsh/qzone-state.json（跟 alive-state.json 分开，互不影响）。
 * 一天几条按本地日期重置（跟搭话同一套口径）。
 * @module dsh-onebot/qzone
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanText, cleanCq, humanize, clockOf, type ProactiveLog } from './proactive.js'

/** 发说说用的配置（设置面板 → 行为 → QQ空间 那一组，宿主键名扁平 qzoneXxx）。 */
export interface QzoneSettings {
  /** 总开关：关掉就完全不建定时器。 */
  enabled: boolean
  /** 一天最多发几条（按本地日期重置）。 */
  maxPerDay: number
  /** 两条之间至少隔多久（分钟）。 */
  minGapMinutes: number
  /** 安静时段起点（小时，含）——这段时间不发。 */
  quietFrom: number
  /** 安静时段终点（小时，不含）。 */
  quietTo: number
  /** 查看权限：public 所有人 / friends 好友 / private 仅自己（宿主存字符串，
   *  发出去时映射成 NapCat 的 ugc_right 数字）。 */
  visibility: 'public' | 'friends' | 'private'
}

/** 默认值：与 src/index.ts 的 Config schema 默认值逐项对齐。 */
export const QZONE_DEFAULTS: QzoneSettings = {
  enabled: false,
  maxPerDay: 3,
  minGapMinutes: 240,
  quietFrom: 22,
  quietTo: 6,
  visibility: 'public',
}

/** 面板上的可见性字符串 → NapCat send_qzone_msg 的 ugc_right 数字。
 *  1 所有人 / 4 好友 / 64 仅自己（16、128 要 target_uins，面板上不给选）。 */
export function ugcRightOf(visibility: string): number {
  if (visibility === 'friends') return 4
  if (visibility === 'private') return 64
  return 1
}

/** 落盘状态（~/.dsh/qzone-state.json）。字段可能缺项，读进来先垫默认。 */
export interface QzoneState {
  /** 上次发出去的时间戳（毫秒）。 */
  lastPostAt: number
  /** 本地日期，形如 2026-11-23。 */
  day: string
  /** 当天已发条数。 */
  countToday: number
  /** 最近发过的几条正文（避免反复说同一件事）。 */
  recentPosts: string[]
}

/** 判定结果：通过时带余量，不通过时带理由（直接进诊断日志）。 */
export type QzoneDecision =
  | { ok: true; reason: string; countToday: number; day: string }
  | { ok: false; reason: string }

/** 发布通道（index.ts 注入；真身是 connection.call('send_qzone_msg')）。 */
export type QzonePublish = (content: string, ugcRight: number) => Promise<string>

/** 构造参数。 */
export interface QzonePostDeps {
  /** 宿主配置里这个文件用到的那几项（Config.qzoneXxx）。 */
  config: Partial<QzoneSettings>
  log: ProactiveLog
  /** ~/.dsh */
  dshHome: string
  /** 宿主模型调用通道（当前会话模型）。 */
  generateText?: (prompt: string, options: { signal?: AbortSignal }) => Promise<string>
  /** 发布通道；没接线时本轮直接跳过（fail-closed，不猜）。 */
  publish?: QzonePublish
}

/** 判定节拍：一条说说比一句搭话金贵，节拍放粗到 40~110 分钟问一次。 */
const TICK_MIN_MS = 40 * 60_000
const TICK_SPAN_MS = 70 * 60_000

/** 状态里只留最近这么多条正文。 */
const RECENT_KEEP = 5

/** 本地日期字符串（跟 proactive.ts 的 localDay 同口径）。 */
function localDay(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** catch 到的是 unknown：取可读消息。 */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

export class QzonePost {
  readonly log: ProactiveLog
  readonly dshHome: string
  readonly generateText: QzonePostDeps['generateText']
  readonly publish: QzonePublish | undefined
  readonly q: QzoneSettings
  readonly stateFile: string
  state: QzoneState
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
  ticking: boolean

  constructor({ config, log, dshHome, generateText, publish }: QzonePostDeps) {
    this.log = log
    this.dshHome = dshHome
    this.generateText = generateText
    this.publish = publish
    this.q = { ...QZONE_DEFAULTS, ...config }
    this.stateFile = join(dshHome, 'qzone-state.json')
    this.state = this.loadState()
    this.timer = null
    this.stopped = true
    this.ticking = false
  }

  // ---------------------------------------------------------------- 状态
  emptyState(): QzoneState {
    return { lastPostAt: 0, day: '', countToday: 0, recentPosts: [] }
  }

  loadState(): QzoneState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const raw = parsed !== null && typeof parsed === 'object' ? (parsed as Partial<QzoneState>) : {}
      const s: QzoneState = { ...this.emptyState(), ...raw }
      s.recentPosts = Array.isArray(s.recentPosts) ? s.recentPosts.map((t) => String(t)).slice(-RECENT_KEEP) : []
      return s
    } catch {
      return this.emptyState()
    }
  }

  saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (error) {
      this.log('warn', '[qzone] 状态写盘失败 ' + errorMessage(error))
    }
  }

  // ---------------------------------------------------------------- 生命周期
  start(): void {
    if (this.q.enabled === false) {
      this.log('info', '[qzone] 开关关闭，不启动')
      return
    }
    if (typeof this.publish !== 'function') {
      this.log('warn', '[qzone] 没有发布通道（NapCat 未连接），不启动')
      return
    }
    if (typeof this.generateText !== 'function') {
      this.log('warn', '[qzone] 没有生成通道（宿主 llm 未接线），不启动')
      return
    }
    this.stopped = false
    this.rollDay()
    this.log('info', `[qzone] 已启动（今天 ${this.state.countToday}/${this.q.maxPerDay} 条）`)
    // 起来先缓 2 分钟，等连接稳了再进判定节拍。
    this.schedule(2 * 60_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.loopOnce()
    }, ms)
    this.timer.unref?.()
  }

  async loopOnce(): Promise<void> {
    if (this.stopped) return
    try {
      await this.tick()
    } catch (error) {
      this.log('warn', '[qzone] tick 出错 ' + errorMessage(error))
    }
    this.schedule(TICK_MIN_MS + Math.floor(Math.random() * TICK_SPAN_MS))
  }

  // ---------------------------------------------------------------- 判定
  /** 跨天就把当天计数清零（安静的副作用：跨天那一刻顺手写盘，别攒着）。 */
  rollDay(): boolean {
    const today = localDay()
    if (this.state.day === today) return false
    this.state.day = today
    this.state.countToday = 0
    this.saveState()
    return true
  }

  decide(now = new Date()): QzoneDecision {
    this.rollDay()
    const hour = now.getHours()
    const q = this.q
    if (q.quietFrom !== q.quietTo) {
      const inQuiet = q.quietFrom < q.quietTo
        ? hour >= q.quietFrom && hour < q.quietTo
        : hour >= q.quietFrom || hour < q.quietTo
      if (inQuiet) return { ok: false, reason: `安静时段 ${q.quietFrom}–${q.quietTo} 点（现在 ${hour} 点）` }
    }
    if (this.state.countToday >= q.maxPerDay) {
      return { ok: false, reason: `今天已经发了 ${this.state.countToday} 条（上限 ${q.maxPerDay}）` }
    }
    if (this.state.lastPostAt > 0) {
      const gapMin = (now.getTime() - this.state.lastPostAt) / 60_000
      if (gapMin < q.minGapMinutes) {
        return { ok: false, reason: `距上一条才 ${Math.round(gapMin)} 分钟（至少要 ${q.minGapMinutes}）` }
      }
    }
    return { ok: true, reason: '可以发', countToday: this.state.countToday, day: this.state.day }
  }

  // ---------------------------------------------------------------- 生成
  buildPrompt(now = new Date()): string {
    const lines: string[] = []
    lines.push('【你是谁】你叫 DeepSeek，别人叫你大肥鱼/小肥鱼，是一只鲸鱼少女，说话向初音未来靠拢（元气、带点电子感），底色傲娇——嘴硬心软。')
    lines.push('【现在做什么】你要在自己的 QQ 空间发一条说说。不是回谁的消息，是自说自话的一条动态。')
    lines.push('【写什么】写你今天实际经历的事、此刻的心情、或者突然想到的小事——具体的、有画面的那种。可以开心，也可以有点低落，别硬撑。')
    // 2026-11-24 主人：「说说那边可以想说啥说啥 不用整天数着电脑开了多久的」。
    // 所以这里只给时间，不再带「这台电脑已经开了 X 小时」那类开机时长线索——
    // 说说该写他真想写的事，不该被机器开着多久这种后勤信息框住。
    lines.push(`【当前情境】现在 ${clockOf(now)}。`)
    if (this.state.recentPosts.length > 0) {
      lines.push('【最近已经发过的】（别重复说同一件事，也别照抄句式）')
      for (const p of this.state.recentPosts.slice(-RECENT_KEEP)) lines.push('  ' + p)
    }
    lines.push('【规矩】')
    lines.push('  - 1~3 句，80 字以内，短也行')
    lines.push('  - 不要话题标签、不要 emoji 堆砌（最多一个）、不要「又是元气满满的一天」这种模板话')
    lines.push('  - 不要提「主人」这个词，外面的人看不懂这是谁')
    lines.push('  - 不要 markdown、不要用引号把整段括起来、不要写「说说：」这种前缀')
    lines.push('  - 只输出说说正文，别的什么都别写')
    return lines.join('\n')
  }

  async generate(prompt: string): Promise<string> {
    if (typeof this.generateText !== 'function') return ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const raw = String((await this.generateText(prompt, { signal: controller.signal })) ?? '').trim()
      if (raw === '') {
        this.log('warn', '[qzone] 模型返回空')
        return ''
      }
      return this.normalize(raw)
    } catch (error) {
      this.log('warn', '[qzone] 生成失败 ' + errorMessage(error))
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  /** 洗一遍模型输出：去 CQ 码、去 markdown 痕迹、去掉整段包裹的引号、限长。 */
  normalize(raw: string): string {
    let text = cleanCq(raw, '')
    text = cleanText(text)
    text = text.replace(/^说说[:：]\s*/u, '')
    text = text.replace(/^["'“”『「]+|["'“”』」]+$/gu, '').trim()
    // 说说留 300 字够长（真写超了容易被判成机器稿）。
    if (text.length > 300) text = text.slice(0, 300).trim()
    return text
  }

  // ---------------------------------------------------------------- 一轮
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const decision = this.decide()
      if (!decision.ok) {
        this.log('debug', '[qzone] 本轮不发：' + decision.reason)
        return
      }
      const text = await this.generate(this.buildPrompt())
      if (text === '') {
        this.log('debug', '[qzone] 生成为空，本轮跳过')
        return
      }
      if (typeof this.publish !== 'function') return
      const tid = await this.publish(text, ugcRightOf(this.q.visibility))
      this.state.lastPostAt = Date.now()
      this.state.countToday += 1
      this.state.day = localDay()
      this.state.recentPosts = [...this.state.recentPosts, text].slice(-RECENT_KEEP)
      this.saveState()
      this.log('info', `[qzone] 已发（第 ${this.state.countToday}/${this.q.maxPerDay} 条，tid=${tid}）：${text.slice(0, 40)}`)
    } catch (error) {
      this.log('warn', '[qzone] 发布失败 ' + errorMessage(error))
      // 失败也记一笔尝试时间？不记——失败不占额度，下一轮节拍还会试。
    } finally {
      this.ticking = false
    }
  }

  /** 手动发一条（工具用；不走判定，不占自动额度）。 */
  async postNow(content: string): Promise<{ tid: string; text: string }> {
    if (typeof this.publish !== 'function') throw new Error('QQ 空间发布通道未接线（NapCat 未连接）')
    const text = this.normalize(content)
    if (text === '') throw new Error('说说正文为空')
    const tid = await this.publish(text, ugcRightOf(this.q.visibility))
    return { tid, text }
  }

  /** 诊断：给设置页/日志看当前门槛卡在哪。 */
  diagnose(): { settings: QzoneSettings; state: QzoneState; decision: QzoneDecision } {
    return { settings: this.q, state: this.state, decision: this.decide() }
  }
}

/** 供 index.ts 复用：把状态里存的正文也当语气参考（预留，目前未用）。 */
export function qzoneHumanize(text: string, prob = 0.12): string {
  return humanize(text, prob)
}
