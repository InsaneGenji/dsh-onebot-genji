/**
 * 客户端设置页 UI bundle 测试（T8 · 贡献者 0.9.19 版重写；0.10.0 视觉对齐更新）。
 *
 * 验证 src/client.ts（构建产物 lib/client.js，CJS 包裹挂 window.__ModuleLoader__）
 * 的模块级契约：
 *   ① 语法可解析（new Function）+ CJS banner/footer 形态 + externals = react 与
 *      宿主 UI 原语 seed 模块（@deepseek-ai/dsh-client-ui-primitives，缺失回落 shim）；
 *   ② 入口导出 inject + apply；T11 侧边栏入口成对注册（main + sidebar.panellist 同 id）；
 *   ③ 六组 62 键：分组/键序/默认值与宿主侧 src/settings-remote.ts 导出常量逐字
 *      一致（descriptor 契约核对，防两侧漂移）；notices 为 5 真键（无贡献者 newSession）；
 *      2026-11-18 面板下架键（ignoreSelf/agentPreset/forceSessionId/allowAllUsers/
 *      replyCountsAsMention/reactionOnMention/reactionEmoji/faceStyle/
 *      restrictedMemberPrefix/sidebarEntryEnabled）与「旁观」整组只退面板，
 *      schema/ALL_KEYS/DEFAULTS 全保留；
 *   ④ Typert descriptor 与宿主服务方法面逐字对齐：getSettings() /
 *      updateSettings(patch, expectedRevision) / listWorkspaces()，全 positional，
 *      patch/config codec 覆盖全部在用键（防客户端网关按 schema 剥键丢编辑）；
 *   ⑤ 渲染函数模块级可测：renderGroup 纯函数产出 62 键控件行，控件经 opts.ui 依赖
 *      注入（测试用桩，宿主 primitives / 回落 shim 同契约）；showIf 条件显隐；
 *      accessToken 密码型输入且不明文回显；布尔行 Switch 左右布局；
 *      notices 行为组按 newMessagePolicy 档位显隐；
 *   ⑥ W6「非默认」徽标对所有类型键挂标（title=与默认值不同，经 ui.Tag）；
 *   ⑦ 0.10.0：诊断组折叠随页签式导航移除（无 details/summary、无 sessionStorage）；
 *   ⑧ 保存语义：computePatch 产出差异子集 patch；stringArray 宽分隔符；数字非法键
 *      不进 patch；mergeOnConflict 冲突合并；数字行内校验（NUMBER_RANGE 对齐 host，
 *      校验时机 = onChange 即时）。
 *
 * @module dsh-onebot/tests/client-settings
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ALL_KEYS,
  NAMESPACE,
  NOTICE_KEYS,
  REMOTE_EFFECT,
  SCHEMA_DEFAULTS,
  SECRET_KEYS,
  SETTINGS_GROUPS,
} from '../src/settings-remote.js'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 极简 React 替身：createElement 产出可遍历的元素树（渲染函数模块级可测）。 */
type StubElement = { type: unknown; props: Record<string, unknown>; children: unknown[] }
const stubReact = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true) }
  },
}
function walk(node: unknown): StubElement[] {
  if (node === null || typeof node !== 'object') return []
  const out: StubElement[] = []
  const element = node as StubElement
  if (element.type !== undefined && typeof element.props === 'object' && element.props !== null) out.push(element)
  for (const child of element.children ?? []) out.push(...walk(child))
  return out
}
/** 顶层字段行计数：只认精确 className，避免嵌套 obx-field-text 误计。 */
function topFieldRows(section: StubElement): StubElement[] {
  const out: StubElement[] = []
  const scan = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (node && typeof node === 'object' && (node as StubElement).type !== undefined) {
        const element = node as StubElement
        const className = String(element.props.className ?? '')
        if (className === 'obx-field' || className === 'obx-field obx-field--row') out.push(element)
        else scan(element.children ?? [])
      }
    }
  }
  scan(section.children ?? [])
  return out
}

/** ui 组件桩：与宿主 primitives / 回落 shim 同 props 契约（见 src/client.ts fallbackUi 注释）。 */
const stubUiComponent = (name: string) => {
  const component = (props: Record<string, unknown>) => stubReact.createElement(`ui-${name}`, props)
  return component
}
const stubUi = {
  Switch: stubUiComponent('switch'),
  Checkbox: stubUiComponent('checkbox'),
  Tag: stubUiComponent('tag'),
  Button: stubUiComponent('button'),
  SegmentedControl: stubUiComponent('segmented'),
  SegmentedTabs: stubUiComponent('tabs'),
  Input: stubUiComponent('input'),
}

/** CJS 包裹装载：模拟 window.__ModuleLoader__.load + require 外部表（react + 宿主原语 seed）。 */
function loadClientModule(): Record<string, unknown> {
  const factories: Record<string, (request: (spec: string) => unknown) => unknown> = {}
  const globalWithWindow = globalThis as unknown as { window?: { __ModuleLoader__: unknown } }
  globalWithWindow.window = { __ModuleLoader__: { load: (entry: { id: string; factory: (request: (spec: string) => unknown) => unknown }) => { factories[entry.id] = entry.factory } } }
  // 求值 bundle 源码：new Function 体在调用时经全局 window 找到 ModuleLoader 桩完成注册。
  new Function(CLIENT_SOURCE)()
  const factory = factories['dsh-onebot-genji']
  if (factory === undefined) throw new Error('lib/client.js 未注册 dsh-onebot-genji 模块')
  return factory((spec: string) => {
    if (spec === 'react') return stubReact
    // 宿主原语 seed 模块在测试环境缺席：bundle 侧 try/catch 回落 shim（同旧宿主路径）
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('seed 表缺席（测试环境）')
    throw new Error(`unexpected external require: ${spec}`)
  }) as Record<string, unknown>
}

const client = loadClientModule()
/** 词条桩：与面板 ctx.locale.bind 的 t 同口径（0.10.0 字段文案词典化）。 */
const localeZh = client.LOCALE_ZH as Record<string, string>
const stubT = (key: string) => (localeZh[key] !== undefined ? localeZh[key] : key)
const descriptors = client.ONEBOT_SETTINGS_DESCRIPTORS as Array<Record<string, unknown>>
const groups = client.GROUPS as Array<{ id: string; title: string; fields: Array<{ key: string; label: string; type: string; options?: string[]; hint?: string; showIf?: { key: string; value: unknown } }> }>
const allFields = client.ALL_FIELDS as Array<{ key: string; type: string; showIf?: { key: string; value: unknown } }>
const draft = client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>
const defaults = client.DEFAULTS as Record<string, unknown>

/** 宿主形态快照 config：SCHEMA_DEFAULTS 全 80 键（含 notices + chatIdleEvictDays），accessToken 按脱敏约定为 ''。 */
const SNAPSHOT_CONFIG: Record<string, unknown> = { ...SCHEMA_DEFAULTS, accessToken: '' }
const baseDraft = () => draft({ config: SNAPSHOT_CONFIG })
const renderGroup = (groupId: string, opts: Record<string, unknown>) =>
  (client.renderGroup as Function)(stubReact, groups.find((entry) => entry.id === groupId), {
    draft: baseDraft(),
    ui: stubUi,
    t: stubT,
    onChange: () => {},
    onSecretChange: () => {},
    onClearSecretChange: () => {},
    ...opts,
  }) as StubElement
const flat = (section: StubElement) => JSON.stringify(walk(section))

describe('T8 客户端 bundle — 装载契约（CJS 包裹 / externals / 入口导出）', () => {
  it('语法可解析：new Function 直接解析 lib/client.js 全文', () => {
    expect(() => new Function(CLIENT_SOURCE)).not.toThrow()
  })

  it('CJS 包裹形态：banner window.__ModuleLoader__.load({id, factory:(require)=>{ + footer return module.exports', () => {
    expect(CLIENT_SOURCE).toContain('window.__ModuleLoader__.load({')
    expect(CLIENT_SOURCE).toContain('id: "dsh-onebot-genji",')
    expect(CLIENT_SOURCE).toContain('factory: (require) => {')
    // tsc 重排印后 footer 缩进为空格（源 src/client.ts 为 tab）。
    expect(CLIENT_SOURCE.trimEnd().endsWith('return module.exports;\n    }\n});')).toBe(true)
  })

  it('externals = react + 宿主 UI 原语 seed 模块（缺失时 try/catch 回落 shim）', () => {
    const requireCalls = CLIENT_SOURCE.match(/require\s*\(/g) ?? []
    const reactCalls = CLIENT_SOURCE.match(/require\s*\(\s*["']react["']\s*\)/g) ?? []
    expect(reactCalls.length).toBe(1)
    expect(CLIENT_SOURCE).toContain('require(HOST_PRIMITIVES_ID)')
    expect(CLIENT_SOURCE).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(requireCalls.length).toBe(reactCalls.length + 1) // 恰一处宿主原语 require（try/catch 包裹）
    expect(requireCalls.length).toBeGreaterThan(0)
  })

  it('入口导出 inject（宿主客户端服务名数组）+ apply(ctx)', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'remote'])
    expect(typeof client.apply).toBe('function')
    expect(typeof client.OnebotSettingsPanel).toBe('function')
  })

  it('无 node:/npm 运行时依赖；@deepseek-ai 仅允许宿主原语 seed 模块', () => {
    expect(CLIENT_SOURCE).not.toMatch(/require\s*\(\s*["'](node:|schemastery)/)
    expect(CLIENT_SOURCE).not.toMatch(/require\s*\(\s*["']@deepseek-ai\/(?!dsh-client-ui-primitives")/)
    expect(CLIENT_SOURCE).not.toMatch(/\bimport\s/)
  })

  it('T11 边界：侧边栏入口图标为自绘 SVG（QQ 专属图形，非宿主图标表）', () => {
    expect(CLIENT_SOURCE).toContain('sidebar.panellist') // T11：侧边栏列表槽注入
    expect(CLIENT_SOURCE).toContain('OnebotSidebarIcon')
    expect(CLIENT_SOURCE).toContain('SIDEBAR_PANEL_ID')
    expect(client.OnebotSidebarIcon).toBeTypeOf('function')
    expect(client.SIDEBAR_PANEL_ID).toBe('qq-bot')
    expect(CLIENT_SOURCE).toContain('obx-panel') // 面板构建标记（原生 UI 重写后的根 class 前缀）
  })
})

describe('T8 客户端 bundle — descriptor 契约核对（与宿主 src/settings-remote.ts 逐字对齐）', () => {
  it('namespace/service = onebotSettings，与宿主 NAMESPACE 常量一致', () => {
    expect(client.ONEBOT_SETTINGS_REMOTE).toEqual({ package: 'dsh-onebot-genji', descriptors })
    for (const descriptor of descriptors) {
      expect(descriptor.namespace).toBe(NAMESPACE)
      expect(descriptor.service).toBe(NAMESPACE)
      expect(descriptor.method).toBeTypeOf('string')
      expect(descriptor.id).toBe(`dsh-onebot-genji#${NAMESPACE}/${String(descriptor.method)}`)
    }
  })

  it('方法集逐字对齐：getSettings() 0 参；updateSettings(patch, expectedRevision)；listWorkspaces() 0 参，全 positional', () => {
    // 2026-11-19：表情包库的 8 个远程方法进 descriptor 表（clearDeleted 只在宿主侧接线，
    // 客户端面板暂不暴露），前三个宿主设置方法的位置不变。
    expect(descriptors.map((descriptor) => descriptor.method)).toEqual([
      'getSettings', 'updateSettings', 'listWorkspaces',
      'listStickers', 'addSticker', 'deleteSticker', 'approveStickers', 'unapproveStickers',
      'readSticker', 'retagStickers', 'updateSticker',
    ])
    const getSettings = descriptors[0] as { parameters: Array<unknown>; result: { schema: { parse(value: unknown): unknown } } }
    expect(getSettings.parameters).toEqual([])
    const updateSettings = descriptors[1] as { parameters: Array<{ name: string }>; result: { schema: { parse(value: unknown): unknown } } }
    expect(updateSettings.parameters.map((parameter) => parameter.name)).toEqual(['patch', 'expectedRevision'])
    const listWorkspaces = descriptors[2] as { parameters: Array<unknown>; result: { typeSymbol: string; schema: { parse(value: unknown): unknown } } }
    expect(listWorkspaces.parameters).toEqual([])
    expect(listWorkspaces.result.typeSymbol).toBe('WorkspaceListResult')
    expect(listWorkspaces.result.schema.parse({ available: true, workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }] })).toEqual({
      available: true,
      workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }],
    })
    expect(listWorkspaces.result.schema.parse({ available: false, workspaces: [] })).toEqual({ available: false, workspaces: [] })
  })

  it('result codec 可解析宿主形态快照（101 键 config 含 notices/chatIdleEvictDays + secrets 脱敏标记 + groups + effect=restart）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const snapshot = {
      revision: 3,
      entryActive: true,
      config: { ...SNAPSHOT_CONFIG },
      secrets: SECRET_KEYS.map((key) => ({ path: [key], set: key === 'accessToken' })),
      groups: SETTINGS_GROUPS,
      effect: REMOTE_EFFECT,
    }
    const parsed = getSettings.result.schema.parse(snapshot) as { config: Record<string, unknown> }
    expect(parsed.config.accessToken).toBe('')
    // T6/T7 转正键不被客户端 codec 剥掉（防网关按 schema 剥键丢编辑）
    expect(parsed.config.gifFramesEnabled).toBe(false)
    expect(parsed.config.inboxQueueEnabled).toBe(false)
    expect(parsed.config.inboxQueueDelayMs).toBe(600)
    expect(parsed.config.titleSyncEnabled).toBe(true) // T24：schema/DEFAULTS 默认开
    // 2026-11-19：客户端 codec 重新覆盖全部 ALL_KEYS（含面板下架的 reactionOnMention/
    // reactionEmoji）——面板不渲染不等于网关可以剥键，老配置里的值照样透传。
    expect(parsed.config.reactionOnMention).toBe(false)
    expect(parsed.config.reactionEmoji).toBe(178)
    expect(parsed.config.allowAllUsers).toBe(false) // 面板下架但 schema/codec 仍保留（老配置可读）
    expect(Object.keys(parsed.config)).toHaveLength(97) // 90 ALL_KEYS 配置键 + notices（旁观 5 键 2026-11-20 已删；补话 5 键 2026-11-22 已删）
    expect(parsed.config.notices).toEqual(SCHEMA_DEFAULTS.notices)
  })

  it('result codec 拒绝缺键/多 effect 快照（严格 codec，防宿主契约漂移静默通过）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const missing = { ...SNAPSHOT_CONFIG }
    delete missing.port
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: missing, secrets: [], groups: SETTINGS_GROUPS, effect: 'restart' })).toThrow()
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: SNAPSHOT_CONFIG, secrets: [], groups: SETTINGS_GROUPS, effect: 'none' })).toThrow()
  })

  it('updateSettings patch codec 接受全部键任意子集（含 T6/T7 转正键与 notices）、拒绝非法值', () => {
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patchCodec = updateSettings.parameters[0].codec.schema
    expect(patchCodec.parse({ port: 1234, mode: 'reverse' })).toEqual({ port: 1234, mode: 'reverse' })
    expect(patchCodec.parse({ gifFramesEnabled: true, inboxQueueEnabled: true, inboxQueueDelayMs: 800 })).toEqual({
      gifFramesEnabled: true,
      inboxQueueEnabled: true,
      inboxQueueDelayMs: 800,
    })
    // T24：标题同步开关进 patch codec（防网关剥键丢编辑）。
    expect(patchCodec.parse({ titleSyncEnabled: true })).toEqual({ titleSyncEnabled: true })
    expect(() => patchCodec.parse({ titleSyncEnabled: 'yes' })).toThrow()
    // #61 建议 2：启动恢复会话开关进 patch codec（防网关剥键丢编辑）。
    expect(patchCodec.parse({ startupResumeEnabled: false })).toEqual({ startupResumeEnabled: false })
    expect(() => patchCodec.parse({ startupResumeEnabled: 'yes' })).toThrow()
    // 2026-11-19：下架键重新进 patch codec（老配置可改、类型不符照样抛错）。
    expect(patchCodec.parse({ reactionOnMention: true, reactionEmoji: 128 })).toEqual({ reactionOnMention: true, reactionEmoji: 128 })
    expect(() => patchCodec.parse({ reactionOnMention: 'yes' })).toThrow()
    expect(() => patchCodec.parse({ reactionEmoji: '178' })).toThrow()
    expect(patchCodec.parse({ forceSessionId: 'abc123' })).toEqual({ forceSessionId: 'abc123' })
    expect(patchCodec.parse({ notices: { queue: '自定义', answerAccepted: false } })).toEqual({ notices: { queue: '自定义', answerAccepted: false } })
    expect(() => patchCodec.parse({ mode: 'invalid' })).toThrow()
    expect(() => patchCodec.parse({ gifFramesEnabled: 'yes' })).toThrow()
    expect(() => patchCodec.parse({ notices: { queue: 5 } })).toThrow()
  })
})

describe('T8 客户端 bundle — 六组 62 键（面板下架键与旁观组已移出，host SETTINGS_GROUPS 同步收窄、schema 键保留）', () => {
  /** 2026-11-19 面板口径：82 键 × 7 组，逐字对齐 src/client.ts GROUPS。 */
  const PANEL_GROUPS: Record<string, string[]> = {
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ'],
    permissions: [
      'requireMention', 'memberTools', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowFrom',
      'groupAllowFrom', 'wakeNamesAdmin', 'atAllCountsAsMention', 'pokeEnabled',
      'groupContextLines', 'sensitivePatterns',
    ],
    behavior: [
      'rateLimitPerMinute', 'voiceReplyEnabled', 'voiceReplyProb', 'stickerReplyEnabled', 'stickerReplyProb',
      'unknownCommand', 'newMessagePolicy', 'autoSteerPolicy', 'inboxQueueEnabled',
      'inboxQueueDelayMs', 'interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'deferredTimeoutMs',
      'proactiveEnabled', 'proactiveTargetUsers', 'proactiveMinIdleMinutes', 'proactiveMinGapMinutes',
      'proactiveMaxPerDay', 'proactiveQuietFrom', 'proactiveQuietTo', 'proactiveAttemptGapMinutes',
      'proactiveBurstProb',
    ],
    stickers: ['stickerAutoCollect', 'stickerRoot'],
    qzone: ['qzoneEnabled', 'qzoneVisibility', 'qzoneMaxPerDay', 'qzoneMinGapMinutes', 'qzoneQuietFrom', 'qzoneQuietTo'],
    session: [
      'titleSyncEnabled', 'startupResumeEnabled', 'newSessionGreeting', 'memoryFilesEnabled', 'memoryFiles',
      'workspacePath', 'dmPromptFile', 'groupWorkspacePath', 'groupPromptFile',
    ],
    media: [
      'sttEnabled', 'sttEngine', 'sttCommand', 'sttArgs', 'sttModel', 'textImageEnabled', 'textImageThreshold',
      'cardFooter', 'fontFiles', 'fontFamilies', 'outboundImageMaxBytes', 'maxVoiceBytes', 'maxFileBytes',
      'inboundImageMaxPx', 'inboundFileMaxBytes', 'gifFramesEnabled', 'allowPrivateHosts',
    ],
    diagnostics: ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun', 'logLevel'],
  }

  it('分组键序逐字对齐面板口径（7 组 77 键，含 T6/T7 转正键、T24 titleSyncEnabled、#61 建议 2 startupResumeEnabled、11.19 掷骰四键/表情包组/主动搭话 9 键、11.22 删补话五键）', () => {
    expect(client.GROUP_KEYS).toStrictEqual(PANEL_GROUPS)
    expect(groups.map((group) => group.id)).toEqual(['connection', 'permissions', 'behavior', 'stickers', 'qzone', 'session', 'media', 'diagnostics'])
    expect(allFields).toHaveLength(83)
    const clientKeys = allFields.map((field) => field.key)
    expect(new Set(clientKeys).size).toBe(83) // 无重复
    for (const key of clientKeys) expect([...ALL_KEYS]).toContain(key) // 无孤儿键
    // 面板键 ⊂ host SETTINGS_GROUPS（host 侧仍保留下架键，面板只是不再渲染）
    const hostKeys = Object.values(SETTINGS_GROUPS).flat()
    for (const key of clientKeys) expect(hostKeys).toContain(key)
    // T6/T7 新增键落位
    expect(groups.find((group) => group.id === 'media')!.fields.map((field) => field.key)).toContain('gifFramesEnabled')
    expect(groups.find((group) => group.id === 'behavior')!.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining([
        'inboxQueueEnabled', 'inboxQueueDelayMs',
        'voiceReplyEnabled', 'voiceReplyProb', 'stickerReplyEnabled', 'stickerReplyProb',
        'proactiveEnabled', 'proactiveBurstProb',
      ]),
    )
    // 2026-11-19：表情包组夹在行为与会话之间，只有两个面板键。
    expect(groups.find((group) => group.id === 'stickers')!.fields.map((field) => field.key))
      .toEqual(['stickerAutoCollect', 'stickerRoot'])
    // T24：titleSyncEnabled 上会话组首位（firstMessageAsUser 已从面板换成它）
    expect(groups.find((group) => group.id === 'session')!.fields.map((field) => field.key)).toEqual([
      'titleSyncEnabled', 'startupResumeEnabled', 'newSessionGreeting', 'memoryFilesEnabled', 'memoryFiles',
      'workspacePath', 'dmPromptFile', 'groupWorkspacePath', 'groupPromptFile',
    ])
    // #61 建议 2：启动恢复会话开关落位 session 组第二位
    expect(groups.find((group) => group.id === 'session')!.fields.map((field) => field.key)[1]).toBe('startupResumeEnabled')
    expect(groups.find((group) => group.id === 'media')!.fields.map((field) => field.key)).toContain('allowPrivateHosts')
    expect(groups.find((group) => group.id === 'connection')!.fields.map((field) => field.key)).toEqual([
      'mode', 'host', 'port', 'url', 'accessToken', 'botQQ',
    ])
  })

  it('面板下架键不再渲染，但 schema/ALL_KEYS/DEFAULTS 仍保留（老配置照样能读）', () => {
    const clientKeys = allFields.map((field) => field.key)
    const retiredFromPanel = [
      'ignoreSelf', 'agentPreset', 'forceSessionId', 'allowAllUsers', 'replyCountsAsMention',
      'reactionOnMention', 'reactionEmoji', 'faceStyle', 'restrictedMemberPrefix', 'sidebarEntryEnabled',
      'firstMessageAsUser',
    ]
    for (const key of retiredFromPanel) expect(clientKeys).not.toContain(key)
    // 其中大多数仍留在 host 键表里（首条消息身份与 allowAllUsers 两侧都已不在组表）
    const hostKeys = Object.values(SETTINGS_GROUPS).flat()
    for (const key of [
      'ignoreSelf', 'agentPreset', 'forceSessionId', 'replyCountsAsMention', 'reactionOnMention',
      'reactionEmoji', 'faceStyle', 'restrictedMemberPrefix', 'sidebarEntryEnabled',
    ]) {
      expect(hostKeys).toContain(key)
    }
    // DEFAULTS 里保留了下架键的默认值（值仍可参与 patch 与徽标对照）；
    // reactionOnMention/reactionEmoji 连 DEFAULTS 都未留（面板与默认表同步下架）。
    for (const key of ['ignoreSelf', 'agentPreset', 'forceSessionId', 'allowAllUsers', 'replyCountsAsMention', 'faceStyle', 'restrictedMemberPrefix', 'sidebarEntryEnabled', 'firstMessageAsUser']) {
      expect(key in defaults).toBe(true)
    }
    expect('reactionOnMention' in defaults).toBe(false)
    expect('reactionEmoji' in defaults).toBe(false)
  })

  it('「旁观」2026-11-20 已整套删除（面板分组、schema、ALL_KEYS、DEFAULTS 都不再有）', () => {
    expect(groups.map((group) => group.id)).not.toContain('bystander')
    const bystanderKeys = ['bystanderEnabled', 'bystanderCapacity', 'bystanderCooldownMinutes', 'bystanderDailyLimit', 'bystanderTopics']
    for (const key of bystanderKeys) {
      expect(allFields.map((field) => field.key)).not.toContain(key)
      expect([...ALL_KEYS]).not.toContain(key)
      expect(key in defaults).toBe(false)
    }
  })

  it('默认值逐字对齐 host SCHEMA_DEFAULTS（88 键：77 面板键 + 下架键 + chatIdleEvictDays；notices 走面板 5 真键不在 DEFAULTS）', () => {
    const hostDefaults = SCHEMA_DEFAULTS as Record<string, unknown>
    expect(Object.keys(defaults)).toHaveLength(94) // 含下架键与 chatIdleEvictDays（旁观 5 键 2026-11-20 已删；补话 5 键 2026-11-22 已删）
    expect('notices' in defaults).toBe(false) // notices 由 NOTICE_KEYS 面板通道承载
    expect(defaults.chatIdleEvictDays).toBe(hostDefaults.chatIdleEvictDays) // 不上面板但参与徽标对照
    expect(defaults.sidebarEntryEnabled).toBe(true) // T11：侧边栏入口默认开（设置项已下架，行为恒开）
    expect(defaults.titleSyncEnabled).toBe(true) // T24：标题同步默认开（schema .default(true)）
    expect(defaults.startupResumeEnabled).toBe(true) // #61 建议 2：启动恢复会话默认开（行为零变化）
    expect(defaults.reactionOnMention).toBe(undefined) // 面板与默认表同步下架（schema 侧仍有）
    expect(defaults.reactionEmoji).toBe(undefined)
    for (const [key, value] of Object.entries(defaults)) {
      expect(key in hostDefaults).toBe(true) // 无孤儿键
      expect(value).toEqual(hostDefaults[key])
    }
    // 面板上的每个键都必须有默认值（否则徽标/重置会缺底）
    for (const field of allFields) expect(field.key in defaults).toBe(true)
  })

  it('字段类型与 host 默认值形态一致；枚举字段选项覆盖默认值（9 枚举，#59 memberTools 入列）', () => {
    for (const field of allFields) {
      const fallback = SCHEMA_DEFAULTS[field.key]
      if (field.type === 'boolean') expect(typeof fallback).toBe('boolean')
      else if (field.type === 'number') expect(typeof fallback).toBe('number')
      else if (field.type === 'enum') expect(field.options ?? []).toContain(fallback)
      else if (field.type === 'stringArray') expect(Array.isArray(fallback)).toBe(true)
      else expect(field.type === 'string' || field.type === 'secret').toBe(true)
    }
    const enumField = (key: string) => groups.flatMap((group) => group.fields).find((field) => field.key === key)
    expect(allFields.filter((field) => field.type === 'enum')).toHaveLength(10)
    expect(enumField('mode')?.options).toEqual(['reverse', 'forward'])
    expect(enumField('dmPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('groupPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('unknownCommand')?.options).toEqual(['intercept', 'passthrough'])
    expect(enumField('newMessagePolicy')?.options).toEqual(['queue', 'steer'])
    expect(enumField('autoSteerPolicy')?.options).toEqual(['admin', 'all'])
    expect(enumField('memberTools')?.options).toEqual(['none', 'send', 'all'])
    expect(enumField('logLevel')?.options).toEqual(['debug', 'info', 'warn', 'error'])
    expect(enumField('sttEngine')?.options).toEqual(['auto', 'openai', 'whisper-cpp', 'custom'])
    expect(enumField('faceStyle')).toBeUndefined() // 面板下架
  })

  it('分组标题与字段 label 为中文（T8 要求：贡献者口语短文案 × 中文）', () => {
    expect(groups.map((group) => group.title)).toEqual(['连接', '权限', '行为', '表情包', 'QQ空间', '会话', '媒体', '诊断'])
    for (const field of allFields) expect(field.label).toMatch(/\p{Script=Han}/u)
  })

  it('accessToken 是唯一 secret 字段（脱敏约定：密码型输入 + 不明文回显）', () => {
    const secretFields = allFields.filter((field) => field.type === 'secret')
    expect(secretFields.map((field) => field.key)).toEqual([...SECRET_KEYS])
  })
})

describe('T8 notices 面板 — 5 真键（本仓 schema 无贡献者 newSession）', () => {
  it('草稿含 5 个 notices.* 键，与 host NOTICE_KEYS 一一对应', () => {
    const draftKeys = Object.keys(baseDraft()).filter((key) => key.startsWith('notices.')).map((key) => key.slice('notices.'.length))
    expect(draftKeys).toEqual([...NOTICE_KEYS])
  })

  it('behavior 组恒显全部 5 条通知（含排队提示，不再随档位隐藏）；session 组无通知行', () => {
    const behavior = flat(renderGroup('behavior', { onNoticeChange: () => {} }))
    expect(behavior).toContain('插话提示')
    expect(behavior).toContain('排队提示')
    expect(behavior).toContain('回答回执')
    expect(behavior).toContain('超时补发提示')
    expect(behavior).toContain('限流提示')
    expect(flat(renderGroup('session', {}))).not.toContain('提示文案') // 无通知文案行（0.10.0 起提示词文件在 session 组，裸「提示」会被 label 误伤）
  })

  it('newMessagePolicy 档位不再影响通知行：queue 档同样 5 条恒显，只隐自动插话资格', () => {
    const section = renderGroup('behavior', { draft: { ...baseDraft(), newMessagePolicy: 'queue' }, onNoticeChange: () => {} })
    const rendered = flat(section)
    expect(rendered).toContain('排队提示')
    expect(rendered).toContain('插话提示')
    expect(rendered).not.toContain('自动插话资格')
  })

  it('通知行 = Switch 桩开关 + 开启时文案 textarea（aria-label=「XX提示文案」）', () => {
    const elements = walk(renderGroup('behavior', { onNoticeChange: () => {} }))
    const noticeLabels = ['插话提示', '排队提示', '回答回执', '超时补发提示', '限流提示']
    const switches = elements.filter(
      (element) => element.type === stubUi.Switch && noticeLabels.includes(String(element.props.label ?? '')),
    )
    expect(switches).toHaveLength(5) // 5 条通知恒显、各自可关
    const textareas = elements.filter((element) => element.type === 'textarea' && String(element.props['aria-label'] ?? '').endsWith('文案'))
    expect(textareas.map((element) => element.props['aria-label'])).toEqual(noticeLabels.map((label) => `${label}文案`))
  })

  it('computePatch notices 增量：自定义文案下发 string、恢复默认文案下发 true、关闭下发 false', () => {
    const compute = client.computePatch as (
      draftValues: Record<string, unknown>,
      config: Record<string, unknown>,
      opts?: { secretDraft?: string; clearSecret?: boolean },
    ) => { patch: Record<string, unknown>; invalidKeys: string[] }
    const queueDef = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理'
    const values = baseDraft()
    values['notices.queue'] = { on: true, text: '自定义排队文案' }
    const custom = compute(values, SNAPSHOT_CONFIG)
    // notices 增量合并进 patch.notices：未动键按 draftToNotice 归一为 true（= 默认文案），动的键下发自定义 string
    expect(custom.patch.notices).toEqual({ steerAccepted: true, queue: '自定义排队文案', answerAccepted: true, deferredTimeout: true, rateLimited: true })
    const values2 = baseDraft()
    values2['notices.steerAccepted'] = { on: true, text: '✅ 已作为补充指令提交给当前任务，模型将在下一步读取' } // == 默认文案 → true == 当前生效值 → 无差异，notices 不进 patch
    expect(compute(values2, SNAPSHOT_CONFIG).patch.notices).toBeUndefined()
    const values3 = baseDraft()
    values3['notices.answerAccepted'] = { on: false, text: '' }
    expect(compute(values3, SNAPSHOT_CONFIG).patch.notices).toEqual({ steerAccepted: true, queue: true, answerAccepted: false, deferredTimeout: true, rateLimited: true })
  })
})

describe('T8 showIf 条件显隐 — 贡献者面板交互契约', () => {
  const connection = groups.find((group) => group.id === 'connection')!
  const visibleLabels = (groupId: string, draftOverrides: Record<string, unknown>) => {
    const section = renderGroup(groupId, { draft: { ...baseDraft(), ...draftOverrides } })
    return walk(section).flatMap((element) => {
      if (element.props.className === 'obx-label') return [element.children[0]]
      // 文本/分段控件的 label 在 ui 桩 props 上（原生组件自渲染 label）
      if (element.type === stubUi.Input || element.type === stubUi.SegmentedControl) return [element.props.label]
      return []
    })
  }

  it('mode 联动：forward 显 url 隐 host/port；reverse 显 host/port 隐 url', () => {
    const forward = visibleLabels('connection', { mode: 'forward' })
    expect(forward).toContain('正向 WS 服务器地址')
    expect(forward).not.toContain('反向 WS 监听地址')
    expect(forward).not.toContain('反向 WS 监听端口')
    const reverse = visibleLabels('connection', { mode: 'reverse' })
    expect(reverse).toContain('反向 WS 监听地址')
    expect(reverse).toContain('反向 WS 监听端口')
    expect(reverse).not.toContain('正向 WS 服务器地址')
  })

  it('中间消息联动：interimRecall ← interimMessages、interimRecallMs ← interimRecall（两级级联）', () => {
    const off = visibleLabels('behavior', { interimMessages: false })
    expect(off).not.toContain('自动撤回中间消息')
    expect(off).not.toContain('中间消息保留时长（毫秒）')
    const level1 = visibleLabels('behavior', { interimRecall: false }) // 默认档：撤回开关显、延迟隐藏
    expect(level1).toContain('自动撤回中间消息')
    expect(level1).not.toContain('中间消息保留时长（毫秒）')
    const level2 = visibleLabels('behavior', { interimRecall: true, interimRecallMs: '0' })
    expect(level2).toContain('中间消息保留时长（毫秒）')
  })

  it('autoSteerPolicy ← newMessagePolicy=steer；inboxQueueDelayMs ← inboxQueueEnabled', () => {
    expect(visibleLabels('behavior', {})).toContain('自动插话资格')
    expect(visibleLabels('behavior', { newMessagePolicy: 'queue' })).not.toContain('自动插话资格')
    expect(visibleLabels('behavior', {})).not.toContain('合并等待窗口（毫秒）')
    expect(visibleLabels('behavior', { inboxQueueEnabled: true })).toContain('合并等待窗口（毫秒）')
  })

  it('stt 联动：sttCommand/sttArgs ← sttEngine=custom、sttModel ← sttEngine=openai；memoryFiles ← memoryFilesEnabled', () => {
    const mediaLabels = visibleLabels('media', {})
    expect(mediaLabels).not.toContain('自定义转写程序')
    expect(mediaLabels).not.toContain('转写参数模板')
    expect(mediaLabels).not.toContain('转写模型')
    const custom = visibleLabels('media', { sttEngine: 'custom' })
    expect(custom).toContain('自定义转写程序')
    expect(custom).toContain('转写参数模板')
    const openai = visibleLabels('media', { sttEngine: 'openai' })
    expect(openai).toContain('转写模型')
    expect(visibleLabels('session', {})).not.toContain('记忆文件路径')
    expect(visibleLabels('session', { memoryFilesEnabled: true })).toContain('记忆文件路径')
  })

  it('渲染行计数与 showIf 自洽：默认草稿顶层字段行 77 行 = 可见 67 键 + 通知行；隐藏 16 键（默认 qzoneEnabled=false，qzone 五键全隐）', () => {
    const visible = (field: { showIf?: { key: string; value: unknown } }) => !field.showIf || baseDraft()[field.showIf.key] === field.showIf.value
    const hiddenKeys = allFields.filter((field) => !visible(field)).map((field) => field.key)
    expect(allFields.filter(visible)).toHaveLength(67)
    expect(hiddenKeys).toEqual([
      'host', 'port', 'allowFrom', 'groupAllowFrom', 'inboxQueueDelayMs', 'interimRecallMs',
      'qzoneVisibility', 'qzoneMaxPerDay', 'qzoneMinGapMinutes', 'qzoneQuietFrom', 'qzoneQuietTo',
      'memoryFiles', 'sttCommand', 'sttArgs', 'sttModel', 'textImageThreshold',
    ])
    const rowsPerGroup = groups.map((group) => topFieldRows(renderGroup(group.id, {})).length)
    // connection 4（6-2 隐藏）/ permissions 10（12-2 隐藏）/ behavior 32（13 可见字段 + 4 通知段字段
    // + 10 通知行 + 5 主动搭话多行文案由 fold 展开后计入；2026-11-22 删补话四行 37→32）/ stickers 2 / session 8（9-1 隐藏）
    // media 13（17-4 隐藏）/ diagnostics 7（旁观组已整组下架，不再计行）
    expect(rowsPerGroup).toEqual([4, 10, 32, 2, 1, 8, 13, 7])
    expect(rowsPerGroup.reduce((sum, count) => sum + count, 0)).toBe(77)
  })

  it('2026-11-22 行位调整：deferredTimeoutMs 紧跟「超时补发提示」文案行；sendErrorNotice 夹在「限流提示」和「私聊」之间', () => {
    const rows = topFieldRows(renderGroup('behavior', {}))
    const labelOf = (row: StubElement) => walk(row).filter((element) => element.props.className === 'obx-label').map((element) => String(element.children[0])).join('|')
    const labels = rows.map(labelOf)
    // 2026-11-22 主人要求：发送错误通知从整组最末尾挪到「限流提示」（通知段最后一项）之后、
    // 「私聊」分区第一项（主动搭话）之前。
    const errorRow = labels.indexOf('发送错误通知')
    const rateRow = labels.indexOf('限流提示')
    const proactiveRow = labels.indexOf('主动搭话')
    expect(rateRow).toBeGreaterThan(-1)
    expect(errorRow).toBeGreaterThan(rateRow)
    expect(proactiveRow).toBeGreaterThan(errorRow)
    const timeoutNoticeRow = labels.indexOf('超时补发提示')
    expect(timeoutNoticeRow).toBeGreaterThan(-1)
    expect(labels[timeoutNoticeRow + 2]).toBe('等待模型回复超时（毫秒）') // 开关行 → 文案行 → 超时字段行
    // 通知开关关掉时超时字段退回原字段序位置（在 sendErrorNotice 之前），不再寄生在通知段
    const offDraft = baseDraft()
    offDraft['notices.deferredTimeout'] = { on: false, text: '⏳ 等待模型回复超时（已静默等待约 X 秒），任务仍在后台运行；完成后将自动补发最终结果。如需停止请发送 /stop。' }
    const offLabels = topFieldRows(renderGroup('behavior', { draft: offDraft })).map(labelOf)
    expect(offLabels).toContain('等待模型回复超时（毫秒）')
    // 通知段整体关掉时 sendErrorNotice 仍跟着 @notices 走，位置不变。
    const offErrorRow = offLabels.indexOf('发送错误通知')
    expect(offErrorRow).toBeGreaterThan(offLabels.indexOf('限流提示'))
    expect(offLabels.indexOf('主动搭话')).toBeGreaterThan(offErrorRow)
  })
})

describe('T8 客户端 bundle — 渲染函数模块级可测（renderGroup 纯函数，ui 桩注入）', () => {
  it('七组各产出标题与逐字段控件行；控件类型齐备（9 分段 + 11 多行文本 + 30 开关 + 25 文本输入 + 1 密码框 + 1 清除勾选）', () => {
    const sections = groups.map((group) => renderGroup(group.id, {}))
    expect(sections.map((section) => section.props['data-group'])).toEqual(['connection', 'permissions', 'behavior', 'stickers', 'qzone', 'session', 'media', 'diagnostics'])
    const elements = sections.flatMap((section) => walk(section))
    expect(elements.filter((element) => element.type === stubUi.SegmentedControl)).toHaveLength(9) // 默认 qzoneEnabled=false 时 qzoneVisibility 隐藏，9 枚举中 8 显 + …
    expect(elements.filter((element) => element.type === 'textarea')).toHaveLength(11) // 4 可见 stringArray（含 proactiveTargetUsers）+ 5 通知文案 + 2 主动搭话多行文案
    const inputs = elements.filter((element) => element.type === stubUi.Input)
    expect(inputs.filter((input) => input.props.type === 'text')).toHaveLength(25) // 14 可见 number + 7 可见 string（forward 档 url 显、host/port 隐；默认 qzoneEnabled=false 时 4 个 qzone 数字键也隐）
    expect(inputs.filter((input) => input.props.type === 'password')).toHaveLength(1)
    expect(elements.filter((element) => element.type === stubUi.Switch)).toHaveLength(31) // 25 布尔面板键 + 5 通知开关（恒显；2026-11-22 删 proactiveFollowupEnabled 31→30）
    expect(elements.filter((element) => element.type === stubUi.Checkbox)).toHaveLength(1) // 仅 secret 清除勾选
    expect(elements.filter((element) => element.type === 'input')).toHaveLength(0) // 控件全走 ui 桩；原始 input 不再出现
  })

  it('布尔行左右布局：Switch 桩收 checked/label/disabled（aria 语义由宿主组件承担）', () => {
    const diagnostics = groups.find((group) => group.id === 'diagnostics')!
    const section = renderGroup('diagnostics', { draft: { ...baseDraft(), traceEnabled: true } })
    const switches = walk(section).filter((element) => element.type === stubUi.Switch && String(element.props.label ?? '').includes('决策追踪'))
    expect(switches).toHaveLength(1)
    expect(switches[0].props.checked).toBe(true)
    expect(diagnostics.fields.find((field) => field.key === 'traceEnabled')).toBeDefined()
  })

  it('accessToken 密码型输入且不明文回显：value 恒空、树内不含明文；状态徽标 + 清除勾选三态齐备', () => {
    const snapshot = { config: { ...SNAPSHOT_CONFIG, accessToken: 'super-secret-token' } }
    const redactedDraft = draft(snapshot)
    expect(redactedDraft.accessToken).toBe('') // draftFromSnapshot 脱敏：明文绝不进入草稿
    const section = renderGroup('connection', { draft: redactedDraft, secretSet: true })
    const elements = walk(section)
    const passwordInputs = elements.filter((element) => element.type === stubUi.Input && element.props.type === 'password')
    expect(passwordInputs).toHaveLength(1)
    expect(passwordInputs[0].props.value).toBe('')
    expect(passwordInputs[0].props.placeholder).toBe('••••••••••••••••')
    expect(JSON.stringify(elements)).not.toContain('super-secret-token')
    expect(JSON.stringify(elements)).toContain('已配置（脱敏，不回显）')
    const section2 = renderGroup('connection', { secretSet: false, clearSecret: true })
    const elements2 = walk(section2)
    expect(JSON.stringify(elements2)).toContain('未配置') // secretSet:false + 勾清除仍显「未配置」（既有契约）
    expect(JSON.stringify(elements2)).not.toContain('保存后清空')
    const checkboxes = elements2.filter((element) => element.type === stubUi.Checkbox)
    expect(checkboxes).toHaveLength(1)
    expect(checkboxes[0].props.label).toBe('清除已保存的 AccessToken')
    expect(checkboxes[0].props.checked).toBe(true)
  })
})

describe('T8 补回上游缺口① — W6「非默认」徽标（所有类型键挂标，title=与默认值不同）', () => {
  function badges(draftValues: Record<string, unknown>, nonDefaultKeys: string[]) {
    return groups
      .flatMap((group) => (client.renderGroup as Function)(stubReact, group, {
        draft: draftValues,
        ui: stubUi,
        t: stubT,
        nonDefaultKeys,
        secretSet: false,
        clearSecret: false,
        onChange: () => {},
        onSecretChange: () => {},
        onClearSecretChange: () => {},
        onNoticeChange: () => {},
      }))
      .flatMap((section) => walk(section))
      // W6 徽标 = children 带「与默认值不同」title 的 Tag；密文状态徽标（未配置等）不计
      .filter((element) => element.type === stubUi.Tag && JSON.stringify(element).includes('与默认值不同'))
  }

  it('nonDefaultKeys 命中的键打「非默认」徽标且带 title，未命中不打', () => {
    const draftValues = baseDraft()
    expect(badges(draftValues, [])).toHaveLength(0)
    const traceBadges = badges(draftValues, ['traceEnabled'])
    expect(traceBadges).toHaveLength(1)
    expect(JSON.stringify(traceBadges[0])).toContain('非默认')
    // title 挂在 children span 上（宿主 Tag 不透传多余 props）
    expect(JSON.stringify(traceBadges[0])).toContain('与默认值不同')
  })

  it('T8 语义恢复：不限字段类型——string/number/stringArray/enum 键命中同样挂标（贡献者只给 boolean/enum 挂，上游 W6 全键）', () => {
    const draftValues = baseDraft()
    // string / number / stringArray / enum / boolean 各取一个**当前可见**的面板键
    //（faceStyle 已下架、allowFrom 在默认 dmPolicy=open 下被 showIf 隐藏，均不产出行）
    const hits = ['botQQ', 'rateLimitPerMinute', 'sensitivePatterns', 'logLevel', 'traceEnabled']
    const found = badges(draftValues, hits)
    expect(found).toHaveLength(5)
    for (const badge of found) expect(JSON.stringify(badge)).toContain('与默认值不同')
  })

  it('徽标数据源是快照生效值 vs DEFAULTS（纯客户端计算）：默认快照无任何徽标，改值后对应键出现徽标', () => {
    const panelKeys = (config: Record<string, unknown>) => {
      const valueEquals = (a: unknown, b: unknown) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
      return allFields.filter((field) => !valueEquals(config[field.key], defaults[field.key])).map((field) => field.key)
    }
    expect(panelKeys({ ...SNAPSHOT_CONFIG })).toEqual([])
    const hits = panelKeys({ ...SNAPSHOT_CONFIG, traceEnabled: true, rateLimitPerMinute: 60, gifFramesEnabled: true })
    expect(hits).toHaveLength(3)
    expect(hits.sort()).toEqual(['gifFramesEnabled', 'rateLimitPerMinute', 'traceEnabled'])
    expect(CLIENT_SOURCE).toContain('tr("field.nonDefaultTitle", "与默认值不同")')
  })
})

describe('0.10.0 页签式导航 — 诊断组折叠随折叠交互移除', () => {
  it('诊断组常规 section 形态（无 details/summary 折叠），7 字段行', () => {
    const section = renderGroup('diagnostics', {})
    expect(section.type).toBe('section')
    expect(section.props['data-group']).toBe('diagnostics')
    expect(topFieldRows(section)).toHaveLength(7)
  })

  it('折叠记忆源码已移除（持久化 API/diagnosticsExpanded/summary 词条不再出现）', () => {
    expect(CLIENT_SOURCE).not.toContain('DIAGNOSTICS_EXPANDED_KEY =')
    expect(CLIENT_SOURCE).not.toContain('window.sessionStorage')
    expect(CLIENT_SOURCE).not.toContain('diagnostics.summary')
    expect(CLIENT_SOURCE).not.toContain('collapsible')
  })
})

describe('T8 保存语义 — computePatch / computeDirtyKeys（updateSettings(patch, expectedRevision) 入参构造）', () => {
  const compute = client.computePatch as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => { patch: Record<string, unknown>; invalidKeys: string[] }
  const computeDirtyKeys = client.computeDirtyKeys as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => string[]

  it('仅下发与生效值有差异的键（含 T6/T7 转正键）', () => {
    const values = baseDraft()
    values.port = '9999'
    values.mode = 'reverse'
    values.groupAllowFrom = '111\n222'
    values.gifFramesEnabled = true
    values.inboxQueueDelayMs = '800'
    const { patch, invalidKeys } = compute(values, SNAPSHOT_CONFIG)
    expect(invalidKeys).toEqual([])
    expect(patch).toEqual({ port: 9999, mode: 'reverse', groupAllowFrom: ['111', '222'], gifFramesEnabled: true, inboxQueueDelayMs: 800 })
  })

  it('无差异时 patch 为空对象（no-op 短路，host 不递增 revision）', () => {
    expect(compute(baseDraft(), SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: false }).patch).toEqual({})
  })

  it('accessToken 三态：留空 = 不修改（缺省）；输入 = 明文写入；勾选清除 = 下发空串', () => {
    const values = baseDraft()
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: false }).patch.accessToken).toBeUndefined()
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: 'new-token', clearSecret: false }).patch.accessToken).toBe('new-token')
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: true }).patch.accessToken).toBe('')
  })

  it('数字字段非法输入不进 patch 且单独报告（host validatePatch 二次校验兜底）', () => {
    const values = baseDraft()
    values.interimRecallMs = 'abc'
    values.rateLimitPerMinute = '45'
    const { patch, invalidKeys } = compute(values, SNAPSHOT_CONFIG)
    expect(invalidKeys).toEqual(['interimRecallMs'])
    expect(patch).toEqual({ rateLimitPerMinute: 45 })
  })

  it('stringArray 宽分隔符（T8 贡献者语义）：逗号/顿号/换行皆可拆，空格不拆、trim、去空段', () => {
    const values = baseDraft()
    values.adminUsers = ' 10000 ，20000、30000 \n 40000 '
    expect(compute(values, SNAPSHOT_CONFIG).patch.adminUsers).toEqual(['10000', '20000', '30000', '40000'])
    const values2 = baseDraft()
    values2.allowFrom = 'a b, c'
    expect(compute(values2, SNAPSHOT_CONFIG).patch.allowFrom).toEqual(['a b', 'c']) // 空格不拆
  })

  it('dirtyKeys 与保存流同口径；mode 联动派生（reverse→url、forward→host/port）', () => {
    const deriveModeInactiveKeys = client.deriveModeInactiveKeys as (mode: unknown) => string[]
    const values = baseDraft()
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual([])
    values.port = '9999'
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual(['port'])
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG, { secretDraft: 'tok', clearSecret: false })).toEqual(['port', 'accessToken'])
    values.interimRecallMs = 'abc'
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual(['port']) // 非法数字不入 dirty
    expect(deriveModeInactiveKeys('reverse')).toEqual(['url'])
    expect(deriveModeInactiveKeys('forward')).toEqual(['host', 'port'])
    expect(deriveModeInactiveKeys(undefined)).toEqual([])
  })
})

describe('T8 数字行内校验 — NUMBER_RANGE 对齐 host + numberRangeInvalid 同语义', () => {
  const NUMBER_RANGE = client.NUMBER_RANGE as Record<string, [number, number | undefined]>
  const numberRangeInvalid = client.numberRangeInvalid as (
    field: { key: string; type: string } | null | undefined,
    raw: unknown,
  ) => string | null

  it('NUMBER_RANGE 覆盖全部面板数字键（28 键，含 T7 inboxQueueDelayMs、#58 旁观三键、11.19 掷骰两个概率与主动搭话 12 个数字键；reactionEmoji/chatIdleEvictDays 不上面板不入表）', () => {
    expect(NUMBER_RANGE).toStrictEqual({
      port: [1, 65535],
      rateLimitPerMinute: [0, undefined],
      voiceReplyProb: [0, 1],
      stickerReplyProb: [0, 1],
      interimRecallMs: [0, undefined],
      deferredTimeoutMs: [0, undefined],
      inboxQueueDelayMs: [0, undefined],
      textImageThreshold: [0, undefined],
      maxFileBytes: [1, 4294967296],
      outboundImageMaxBytes: [1, 104857600],
      maxVoiceBytes: [1, 52428800],
      inboundImageMaxPx: [0, undefined],
      inboundFileMaxBytes: [0, undefined],
      groupContextLines: [0, 200],
      proactiveMinIdleMinutes: [0, 1440],
      proactiveMinGapMinutes: [0, 1440],
      proactiveMaxPerDay: [1, 48],
      proactiveQuietFrom: [0, 23],
      proactiveQuietTo: [0, 23],
      proactiveAttemptGapMinutes: [0, 1440],
      proactiveBurstProb: [0, 1],
      qzoneMaxPerDay: [0, 20],
      qzoneMinGapMinutes: [0, 1440],
      qzoneQuietFrom: [0, 23],
      qzoneQuietTo: [0, 23],
    })
    // 键集 = 面板 21 个 number 字段（2026-11-20：「旁观」整组连同 3 个数字键一起删了，
    // 2026-11-22：补话四键删了 25→21；reactionEmoji/chatIdleEvictDays 不上面板也不入表）
    const panelNumberKeys = allFields.filter((field) => field.type === 'number').map((field) => field.key)
    expect(panelNumberKeys).toHaveLength(25) // 2026-11-23：+4 个 qzone 数字键
    expect([...Object.keys(NUMBER_RANGE)].sort()).toEqual([...panelNumberKeys].sort())
    expect(CLIENT_SOURCE).toContain('src/settings-remote.ts')
  })

  it('numberRangeInvalid：越界/NaN 判非法返回范围文案（自带「 的整数」后缀），边界含端点；非 number 不校验', () => {
    const portField = allFields.find((field) => field.key === 'port')!
    const recallField = allFields.find((field) => field.key === 'interimRecallMs')!
    expect(numberRangeInvalid(portField, '70000')).toBe('1–65535 的整数')
    expect(numberRangeInvalid(portField, '0')).toBe('1–65535 的整数')
    expect(numberRangeInvalid(portField, '3000')).toBeNull()
    expect(numberRangeInvalid(portField, '65535')).toBeNull()
    expect(numberRangeInvalid(portField, 'abc')).toBe('1–65535 的整数')
    expect(numberRangeInvalid(portField, '')).toBe('1–65535 的整数')
    expect(numberRangeInvalid(recallField, '-1')).toBe('≥0 的整数')
    expect(numberRangeInvalid(recallField, '0')).toBeNull()
    expect(numberRangeInvalid(recallField, '1e9')).toBeNull()
    expect(numberRangeInvalid(null, 'x')).toBeNull()
    expect(numberRangeInvalid({ key: 'botQQ', type: 'string' }, 'x')).toBeNull()
    // 文案模板只带 range 占位，后缀在 range 文案里（"field.numberInvalid": "必须是 {range}"）
    expect(CLIENT_SOURCE).toContain('"field.numberInvalid": "必须是 {range}"')
    expect(CLIENT_SOURCE).toContain('"field.numberInvalid": "Must be {range}"')
  })

  it('越界标红：number 控件 aria-invalid 透传 + hint 行内嵌红字；校验时机 = onChange 即时', () => {
    const connection = groups.find((group) => group.id === 'connection')!
    const section = (client.renderGroup as Function)(stubReact, connection, {
      draft: { ...baseDraft(), mode: 'reverse' }, // reverse 档位 port 才可见（showIf）
      ui: stubUi,
      t: stubT,
      invalidNumbers: { port: '必须是 1–65535 的有限数字' },
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
    }) as StubElement
    const rendered = JSON.stringify(walk(section))
    expect(rendered).toContain('obx-hint--invalid') // 红字范围提示内嵌 hint 行
    expect(rendered).toContain('必须是 1–65535 的有限数字')
    const narrowControl = walk(section).find((element) => element.props.className === 'obx-control--narrow')!
    const portInput = walk(narrowControl).find((element) => element.type === stubUi.Input)!
    expect(portInput.props['aria-invalid']).toBe(true)
    // tsc 会把单行 if 块展开为多行，这里用正则匹配调用接线（0.10.0 起 onChange 即时校验）
    expect(CLIENT_SOURCE).toMatch(/if \(field\.type === "number"\)\s*\{\s*validateNumberField\(field, nextValue\);/)
    expect(CLIENT_SOURCE).toContain('disabled: busy || dirtyCount === 0 || invalidNumberCount > 0')
  })
})

describe('T8 冲突合并 — mergeOnConflict（远端未变保留草稿、远端已变跟随新快照）', () => {
  const mergeOnConflict = client.mergeOnConflict as (
    draftValues: Record<string, unknown> | null,
    oldConfig: Record<string, unknown> | null,
    nextConfig: Record<string, unknown> | null,
  ) => { draft: Record<string, unknown>; conflictKeys: string[]; keptCount: number }

  it('无冲突：全部本地编辑保留（keptCount=N、conflictKeys=[]），纯函数不改入参', () => {
    const before = baseDraft()
    before.port = '9999'
    before.botQQ = '10086'
    before.traceEnabled = true
    const beforeJson = JSON.stringify(before)
    const merged = mergeOnConflict(before, SNAPSHOT_CONFIG, { ...SNAPSHOT_CONFIG })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(3)
    expect(merged.draft.port).toBe('9999')
    expect(merged.draft.botQQ).toBe('10086')
    expect(merged.draft.traceEnabled).toBe(true)
    expect(merged.draft).not.toBe(before)
    expect(JSON.stringify(before)).toBe(beforeJson)
  })

  it('部分冲突：远端已变的脏键跟随新快照并入 conflictKeys，其余保留；合并覆盖全部 82 面板键', () => {
    const before = baseDraft()
    before.port = '9999'
    before.botQQ = '10086'
    const next = { ...SNAPSHOT_CONFIG, port: 3000 }
    const merged = mergeOnConflict(before, SNAPSHOT_CONFIG, next)
    expect(merged.conflictKeys).toEqual(['port'])
    expect(merged.keptCount).toBe(1)
    expect(merged.draft.port).toBe('3000')
    expect(merged.draft.botQQ).toBe('10086')
    expect(Object.keys(merged.draft)).toHaveLength(83)
    expect((client.computeDirtyKeys as Function)(merged.draft, next)).toEqual(['botQQ'])
  })

  it('空集与 null 防御；密文例外 accessToken 恒 \'\'；stringArray 以「, 」join 展示形态重写', () => {
    const merged = mergeOnConflict(baseDraft(), SNAPSHOT_CONFIG, { ...SNAPSHOT_CONFIG })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(0)
    const defensive = mergeOnConflict(null, null, null)
    expect(defensive.conflictKeys).toEqual([])
    expect(defensive.keptCount).toBe(0)
    const before = baseDraft()
    before.accessToken = 'typed-secret'
    before.rateLimitPerMinute = '60'
    before.botQQ = '10086' // 本地脏键 + 远端已变 → 冲突键
    const next = { ...SNAPSHOT_CONFIG, botQQ: '22222', adminUsers: ['10086', '22222'] }
    const merged2 = mergeOnConflict(before, SNAPSHOT_CONFIG, next)
    expect(merged2.draft.accessToken).toBe('')
    expect(merged2.draft.adminUsers).toBe('10086, 22222')
    expect(merged2.draft.rateLimitPerMinute).toBe('60')
    expect(merged2.conflictKeys).toEqual(['botQQ'])
    expect(CLIENT_SOURCE).toContain('mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config)')
  })
})

describe('T8 workspace 快速填入 — fillWorkspacePath 双键（workspacePath/groupWorkspacePath）', () => {
  const fillWorkspacePath = client.fillWorkspacePath as (draft: Record<string, unknown>, path: string, key?: string) => Record<string, unknown>

  it('纯函数：默认写 workspacePath，第三参可写 groupWorkspacePath；不改入参、nullish 防御', () => {
    const base = baseDraft()
    base.botQQ = '10001'
    const filled = fillWorkspacePath(base, '/vol2/ws/alpha')
    expect(filled).toEqual({ ...base, workspacePath: '/vol2/ws/alpha' })
    expect(base.workspacePath).toBe('')
    expect(filled).not.toBe(base)
    const groupFilled = fillWorkspacePath(base, '/vol2/ws/beta', 'groupWorkspacePath')
    expect(groupFilled.groupWorkspacePath).toBe('/vol2/ws/beta')
    expect(groupFilled.workspacePath).toBe('')
    expect(fillWorkspacePath(base, undefined as unknown as string).workspacePath).toBe('')
    expect(CLIENT_SOURCE).toContain('setDraft(fillWorkspacePath(draft, path, field.key))')
  })

  it('填入后显式保存通道才生效：computePatch 只产出 workspacePath 键', () => {
    const compute = client.computePatch as (draftValues: Record<string, unknown>, config: Record<string, unknown>) => { patch: Record<string, unknown> }
    const filled = fillWorkspacePath(baseDraft(), '/vol2/ws/alpha')
    expect(compute(filled, SNAPSHOT_CONFIG).patch).toEqual({ workspacePath: '/vol2/ws/alpha' })
    expect(compute(fillWorkspacePath(baseDraft(), ''), SNAPSHOT_CONFIG).patch).toEqual({})
  })

  it('picker 正常态：select（value=id，label=path（N 会话））+「填入」按钮（ui 桩）；降级态说明行', () => {
    const renderPicker = client.renderWorkspacePicker as (react: unknown, opts: Record<string, unknown>) => StubElement | null
    const pickerOpts = (overrides: Record<string, unknown> = {}) => ({
      ui: stubUi,
      t: stubT,
      loaded: true,
      available: true,
      workspaces: [
        { id: 'ws-1', path: '/vol2/ws/alpha', sessionCount: 3 },
        { id: 'ws-2', path: '/vol2/ws/beta', sessionCount: 0 },
      ],
      selectedId: '',
      disabled: false,
      onSelectedChange: () => {},
      onApply: () => {},
      ...overrides,
    })
    expect(renderPicker(stubReact, pickerOpts({ loaded: false }))).toBeNull()
    const node = renderPicker(stubReact, pickerOpts())!
    const elements = walk(node)
    const select = elements.find((element) => element.type === 'select')!
    expect((select.props as Record<string, unknown>).value).toBe('')
    const options = select.children as StubElement[]
    expect(options.map((option) => option.props.value)).toEqual(['', 'ws-1', 'ws-2'])
    expect(options.map((option) => option.children[0])).toEqual(['选择 workspace…', '/vol2/ws/alpha（3 会话）', '/vol2/ws/beta（0 会话）'])
    expect(elements.find((element) => element.type === stubUi.Button)!.props.disabled).toBe(true)
    const applied: unknown[] = []
    const selected = renderPicker(stubReact, pickerOpts({ selectedId: 'ws-2', onApply: (path: string) => { applied.push(path) } }))!
    const button = walk(selected).find((element) => element.type === stubUi.Button)!
    expect(button.props.disabled).toBe(false)
    button.props.onClick()
    expect(applied).toEqual(['/vol2/ws/beta']) // 填的是 path，不是 id
  })
})

describe('T8 失败守卫 — host edit-failed 中文错误可渲染且不误判为冲突', () => {
  const unwrap = client.unwrap as (result: unknown) => unknown
  const isConflictError = client.isConflictError as (cause: unknown) => boolean

  it('unwrap({ok:false}) 保留 code 与中文 message', () => {
    const rendered = '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试'
    let caught: unknown
    try {
      unwrap({ ok: false, error: { code: 'onebot-settings/edit-failed', message: rendered } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(rendered)
    expect((caught as { code?: string }).code).toBe('onebot-settings/edit-failed')
  })

  it('edit-failed 不匹配冲突通道；conflict 命中', () => {
    expect(isConflictError({ code: 'onebot-settings/edit-failed', message: '写入失败：宿主 configEditor 拒绝了本次修改' })).toBe(false)
    expect(isConflictError({ code: 'onebot-settings/conflict', message: 'expectedRevision mismatch' })).toBe(true)
  })

  it('面板接线（源码断言）：冲突键编辑撤销 / toast 5 秒 / beforeunload 守卫 / 双语词条', () => {
    expect(CLIENT_SOURCE).toContain('setConflictKeys(conflictKeys.filter(function (key) { return key !== field.key; }));')
    expect(CLIENT_SOURCE).toContain('setTimeout(function () {')
    expect(CLIENT_SOURCE).toContain('t("conflict.secretCleared")')
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。"')
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again."')
  })
})

describe('0.10.0 设置页样式 — dsw token 对齐（页骨架/发丝分隔/布局分支收敛）', () => {
  it('面板容器：1100px 居中内容列（宿主原生页口径），token 引用宿主 --dsw-*', () => {
    const rule = CLIENT_SOURCE.match(/\.obx-panel\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('max-width:1100px')
    expect(rule![0]).toContain('margin-inline:auto')
    expect(rule![0]).toContain('var(--dsw-alias-label-primary')
    expect(rule![0]).toContain('var(--dsw-radius-md,12px)')
  })

  it('字段行发丝分隔：0.5px + 宿主 border-l2 别名（原生表单形态）；组头/子标题后首行无线', () => {
    const field = CLIENT_SOURCE.match(/\.obx-field\{[^}]*\}/)
    expect(field).not.toBeNull()
    expect(field![0]).toContain('border-top:.5px solid var(--obx-hairline)')
    expect(CLIENT_SOURCE).toContain('.obx-group-head+.obx-field,.obx-subgroup-title+.obx-field{border-top:none}')
  })

  it('布局分支收敛：容器查询网格/行内 hint/自造紫色 accent 已移除（label 上、hint 下统一纵向）', () => {
    expect(CLIENT_SOURCE).not.toContain('@container')
    expect(CLIENT_SOURCE).not.toContain('obx-hint-inline')
    expect(CLIENT_SOURCE).not.toContain('obx-input--invalid')
    expect(CLIENT_SOURCE).not.toContain('--obx-accent')
    expect(CLIENT_SOURCE).not.toContain('#6e57af')
  })

  it('自造视觉体系退出：SVG 开关/胶囊页签/密文自绘徽标不再出现（控件交宿主 primitives）', () => {
    expect(CLIENT_SOURCE).not.toContain('obx-toggle--svg')
    expect(CLIENT_SOURCE).not.toContain('obx-btn--pill')
    expect(CLIENT_SOURCE).not.toContain('obx-secret-badge')
    expect(CLIENT_SOURCE).not.toContain('obx-tab{')
  })
})

describe('0.10.0 字段文案词典化 — 新键必须双词（zh 自动灌入 + EN 对照表护栏）', () => {
  const localeEn = client.LOCALE_EN as Record<string, unknown>

  it('78 键 zh label 全部自动灌入且为中文（zh 源 = GROUPS 内联常量，无双源漂移）', () => {
    for (const field of allFields) {
      const value = localeZh[`field.${field.key}.label`]
      expect(typeof value).toBe('string')
      expect(String(value)).toMatch(/\p{Script=Han}/u)
    }
    for (const group of groups) expect(typeof localeZh[`group.${group.id}.title`]).toBe('string')
    for (const key of Object.keys(localeZh)) {
      if (key.startsWith('notice.') && key.endsWith('.label')) expect(typeof localeZh[key]).toBe('string')
    }
  })

  it('en 与 zh 键集逐键齐平（assertSameKeys 护栏口径）；en 文案均为字符串', () => {
    for (const [key, value] of Object.entries(localeZh)) {
      expect(key in localeEn).toBe(true)
      if (typeof value === 'string') expect(typeof localeEn[key]).toBe('string')
    }
    for (const key of Object.keys(localeEn)) expect(key in localeZh).toBe(true)
  })

  it('en 组标题/分区/通知/字段 hint-option-placeholder 齐备；EN_MISSING 告警护栏源码在位', () => {
    for (const group of groups) {
      expect(typeof localeEn[`group.${group.id}.title`]).toBe('string')
      for (const field of group.fields) {
        if (field.hint) expect(typeof localeEn[`field.${field.key}.hint`]).toBe('string')
        if (field.placeholder) expect(typeof localeEn[`field.${field.key}.placeholder`]).toBe('string')
        if (field.optionLabels) {
          for (const value of Object.keys(field.optionLabels)) {
            expect(typeof localeEn[`field.${field.key}.option.${value}`]).toBe('string')
          }
        }
      }
    }
    expect(typeof localeEn['group.permissions.section.dm']).toBe('string')
    expect(typeof localeEn['group.permissions.section.group']).toBe('string')
    expect(typeof localeEn['group.permissions.section.common']).toBe('string')
    expect(typeof localeEn['notice.queue.label']).toBe('string')
    expect(CLIENT_SOURCE).toContain('新键必须双词')
    expect(CLIENT_SOURCE).toContain('exports.LOCALE_ZH = zh;')
    expect(CLIENT_SOURCE).toContain('exports.LOCALE_EN = en;')
  })

  it('渲染走词条：renderGroup/picker 以 t 解析（桩 = LOCALE_ZH），zh 视觉与迁移前逐字一致', () => {
    const rendered = JSON.stringify(walk(renderGroup('connection', { nonDefaultKeys: ['mode'] })))
    expect(rendered).toContain('正向 WS 服务器地址') // label 经词典解析
    expect(rendered).toContain('反向 = 它连我，正向 = 我连它') // hint 经词典解析
    expect(rendered).toContain('非默认') // W6 徽标经词典解析
    expect(rendered).toContain('与默认值不同') // 徽标 title 经词典解析
    // picker 词条由 renderExtraRow 注入（面板层），此处不覆盖——picker 专测见 fillWorkspacePath 组
    const segmented = walk(renderGroup('connection', {})).find((element) => element.type === stubUi.SegmentedControl)!
    expect(JSON.stringify(segmented)).toContain('正向 WebSocket（插件连接 NapCat）') // optionLabels 经词典解析
  })
})
