/**
 * Voice transcription: SILK v3 (magic-number detected) or ffmpeg → WAV, then
 * a whisper engine (openai-whisper CLI, whisper.cpp whisper-cli, or a custom
 * command) produces the transcript. All subprocess work is queued, bounded by
 * a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
  enabled: boolean
  engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom'
  /** Program path/name for the custom engine. */
  command: string
  /** argv template for the custom engine; {file} and {out} are substituted. */
  args: string[]
  /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
  model: string
  /** Per-transcription timeout in ms. */
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/** SILK v3 文件的魔数（QQ 语音落地常见形态）。 */
const SILK_HEADER = '#!SILK_V3'

/**
 * 插件自带的转写桥脚本（随包发布，落在 lib/stt_cli.py）。
 *
 * 相对 import.meta.url 解析：插件装在哪个 profile、哪个盘、符号链接还是实体目录，
 * 都能找到自己那一份，不依赖用户配置。
 */
const BUILTIN_STT_SCRIPT = fileURLToPath(new URL('./stt_cli.py', import.meta.url))
/**
 * 引擎输入的采样率：统一 16 kHz 单声道，与 ffmpeg 管线的 `-ar 16000` 对齐。
 * SILK 文件头里不带采样率，`silk-wasm` 的 `decode(bytes, rate)` 第二参是
 * **输出**采样率、会原生重采样；而 whisper.cpp 的 read_wav() 硬校验 16 kHz
 * （`sampleRate != 16000` 直接失败），所以这里不能沿用 24 kHz。
 */
const STT_SAMPLE_RATE = 16_000

/**
 * 判断文件头是不是 SILK v3。
 *
 * QQ 语音落地时扩展名常被写成 `.mp3`，内容其实是协议端 `get_record`
 * 兜底返回的原始 SILK——ffmpeg 按 mp3 解必然失败（表现为一直只有
 * `[语音]`）。协议端有的会把帧类型字节一起落盘，所以头部允许
 * 0x02 / 0x03 前缀。
 * @param head - 文件前若干字节（>= 10 字节即可）。
 */
export function isSilkData(head: Uint8Array): boolean {
  const offset = head[0] === 0x02 || head[0] === 0x03 ? 1 : 0
  if (head.length < offset + SILK_HEADER.length) return false
  return Buffer.from(head.subarray(offset, offset + SILK_HEADER.length)).toString('latin1') === SILK_HEADER
}

/** 把 16-bit 单声道 PCM 包成最小 WAV（44 字节头），引擎侧都认这个。 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)                 // fmt chunk size
  header.writeUInt16LE(1, 20)                  // PCM
  header.writeUInt16LE(1, 22)                  // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)     // byte rate
  header.writeUInt16LE(2, 32)                  // block align
  header.writeUInt16LE(16, 34)                 // bits per sample
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, Buffer.from(pcm)])
}

/**
 * SILK → 16 kHz 单声道 WAV 之外的「引擎输入」准备。
 *
 * 命中 SILK 魔数时用 `silk-wasm`（纯 wasm，无 native 依赖）解码成 PCM，
 * 再包成 WAV 交给引擎；解码失败就返回 false，让调用方回落到原来的
 * ffmpeg 路径——宁可多试一次，也不要因为解码器不认识某种 SILK 变体
 * 就把整条语音丢掉。
 * @returns true 表示 `outPath` 已写好可用的 WAV。
 */
export async function writeSilkWav(bytes: Uint8Array, outPath: string): Promise<boolean> {
  try {
    const { decode } = await import('silk-wasm')
    const pcm = await decode(bytes, STT_SAMPLE_RATE)
    if (pcm.data.length === 0) return false
    await writeFile(outPath, pcm16ToWav(pcm.data, STT_SAMPLE_RATE))
    return true
  } catch {
    return false
  }
}

/** Run a process, collecting output; rejects on non-zero exit or timeout. */
function runProcess(
  program: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('STT command timed out after ' + timeoutMs + 'ms: ' + program))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error('STT command exited with code ' + code + ': ' + program + '\n' + stderr.slice(-2000)))
    })
  })
}

/**
 * Detect a command on PATH by scanning each dir for an executable match
 * (A8: no shell involved, so the configured name is never shell-interpreted;
 * builtins/aliases stop being visible — callers only need real binaries).
 */
export async function findCommand(name: string): Promise<string | undefined> {
  const win = process.platform === 'win32'
  // Windows: look for what runProcess's shell-less spawn can start, the way libuv
  // resolves a name — the name as given only if it already has an extension, then
  // with .com and .exe appended. PATHEXT is not used: .bat/.cmd need a shell (spawn
  // throws EINVAL since Node 18.20.2/20.12.2/21.7.3, CVE-2024-27980), and the
  // extensionless file npm puts beside a .cmd shim is a sh script.
  const exts = win ? [...(extname(name) !== '' ? [''] : []), '.com', '.exe'] : ['']
  for (const dir of (process.env.PATH ?? '').split(win ? ';' : ':')) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // missing or not executable — try the next candidate
      }
    }
  }
  return undefined
}

/**
 * 找一个**真能跑**的 Python 解释器（Windows 上是 python.exe，或 py.exe 启动器）。
 *
 * 只看 PATH 不够，两件事都得验：
 * 1. Windows 的「应用执行别名」会在 WindowsApps 下留一个 python.exe，一执行就退
 *    9009（"Python was not found"）——把它当解释器用，每条语音都白炸一次。
 * 2. `py.exe` 启动器本身永远能跑，但它指向的默认解释器里未必装了 faster-whisper
 *    ——那样本地兜底一样跑不起来。
 *
 * 所以先挑**装了 faster-whisper** 的解释器（内置脚本真正需要的依赖），一个都没有
 * 再退一步挑只是能跑的（配合常驻服务或外部引擎仍然有用）。结果由调用方缓存。
 */
export async function findPython(): Promise<string | undefined> {
  const candidates: string[] = []
  for (const name of ['python', 'python3', 'py']) {
    const found = await findCommand(name)
    if (found !== undefined && !candidates.includes(found)) candidates.push(found)
  }
  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ['-c', 'import faster_whisper'], 25_000)
      return candidate
    } catch {
      // 没装依赖，试下一个
    }
  }
  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ['-c', 'import sys'], 8_000)
      return candidate
    } catch {
      // 死壳或版本太旧，试下一个
    }
  }
  return undefined
}

/** Locate a whisper.cpp model file for the given model id. */
async function findWhisperCppModel(model: string): Promise<string | undefined> {
  if (model.includes('/') || model.endsWith('.bin')) {
    try {
      await access(model)
      return model
    } catch {
      return undefined
    }
  }
  const name = 'ggml-' + model + '.bin'
  const candidates = [
    '/opt/homebrew/share/whisper.cpp/models/' + name,
    '/usr/local/share/whisper.cpp/models/' + name,
    join(process.env.HOME ?? '', '.cache/whisper.cpp/' + name),
    join(process.env.HOME ?? '', 'whisper.cpp/models/' + name),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try next
    }
  }
  return undefined
}

/**
 * Voice transcription service. One instance per plugin; calls are serialized
 * through a queue so concurrent voice messages cannot stack CPU-bound
 * whisper processes.
 */
export class Transcriber {
  private readonly config: SttConfig
  private queue: Promise<unknown> = Promise.resolve()
  private ffmpegChecked: string | undefined
  private pythonChecked: string | null | undefined

  constructor(config: SttConfig) {
    this.config = config
  }

  /** Whether transcription is enabled by config. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /** 缓存 Python 探测结果（undefined=还没查，null=明确没有）。 */
  private async pythonBinary(): Promise<string | undefined> {
    if (this.pythonChecked === undefined) this.pythonChecked = (await findPython()) ?? null
    return this.pythonChecked ?? undefined
  }

  /**
   * Transcribe a voice file. SILK v3 input is decoded to PCM/WAV directly;
   * everything else is converted to 16 kHz mono WAV with ffmpeg; the WAV is
   * then handed to the selected engine.
   * @param filePath - absolute path of the downloaded voice file.
   * @returns the transcript text (trimmed), or '' when the file is silent.
   * @throws when transcription is impossible (missing tools, timeout...).
   */
  transcribe(filePath: string): Promise<string> {
    const run = this.queue.then(() => this.transcribeNow(filePath))
    // Keep the chain alive regardless of individual failures.
    this.queue = run.catch(() => undefined)
    return run
  }

  private async transcribeNow(filePath: string): Promise<string> {
    const workDir = join(dirname(filePath), 'stt_' + randomUUID().slice(0, 8))
    await mkdir(workDir, { recursive: true })
    try {
      const wavPath = join(workDir, 'audio.wav')

      // QQ 语音落地常是 SILK v3（扩展名却是 .mp3）：先看魔数，命中就直接
      // 解码成 WAV，不再让 ffmpeg 按 mp3 去猜（那样必然 Invalid data）。
      const raw = await readFile(filePath)
      const ready = isSilkData(raw.subarray(0, 16)) ? await writeSilkWav(raw, wavPath) : false

      if (!ready) {
        const ffmpeg = this.ffmpegChecked ?? (await findCommand('ffmpeg'))
        this.ffmpegChecked = ffmpeg
        if (ffmpeg === undefined) {
          throw new Error('STT: ffmpeg not found on PATH (needed to convert QQ voice to WAV)')
        }
        await runProcess(ffmpeg, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], 60_000)
      }

      const engine = await this.resolveEngine()
      const text = await this.runEngine(engine, wavPath, workDir)
      return text.trim()
    } finally {
      // The work dir holds only intermediates (audio.wav, engine output):
      // remove it on both success and failure. Best-effort — a failed cleanup
      // must never lose the transcript (stale dirs are swept later by
      // MediaStore.cleanupExpired as a fallback).
      try {
        await rm(workDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }

  private async resolveEngine(): Promise<'openai' | 'whisper-cpp' | 'custom'> {
    if (this.config.engine === 'custom') return 'custom'
    if (this.config.engine !== 'auto') return this.config.engine
    if ((await findCommand('whisper-cli')) !== undefined) return 'whisper-cpp'
    if ((await findCommand('whisper')) !== undefined) return 'openai'
    if ((await findCommand('mlx_whisper')) !== undefined) return 'openai'
    // 兜底一：配了自定义程序+参数就用它。否则 auto 会完全无视 stt.command/stt.args
    // （历史坑：设置页写着「自动探测」却永远报 no whisper engine found，配好的
    // 本地转写脚本根本不会被调用）。
    if (this.config.command !== '' && this.config.args.length > 0) return 'custom'
    // 兜底二：插件自带 stt_cli.py + PATH 上的 Python。装上插件、随手装个
    // faster-whisper 就能转写，不用用户自己去写脚本。
    if ((await this.pythonBinary()) !== undefined) return 'custom'
    throw new Error(
      'STT: no whisper engine found (tried whisper-cli, whisper, mlx_whisper); install one, set stt.command, '
        + 'or install Python + faster-whisper to use the built-in bridge',
    )
  }

  /** custom 引擎真正要跑的程序与参数（没配就用插件自带的 stt_cli.py）。 */
  private async customSpec(): Promise<{ program: string; args: string[] }> {
    if (this.config.command !== '') {
      return { program: this.config.command, args: this.config.args }
    }
    const python = await this.pythonBinary()
    if (python === undefined) {
      throw new Error(
        'STT: 没配自定义转写程序，PATH 上也找不到 python/python3/py；'
          + '装个 Python（pip install faster-whisper），或在设置里填转写程序',
      )
    }
    const model = this.config.model
    const args = [BUILTIN_STT_SCRIPT, '{file}', '{out}']
    // whisper.cpp 的模型名可能是 .bin 绝对路径，别往 faster-whisper 那边传。
    if (!model.includes('/') && !model.includes('\\') && !model.endsWith('.bin')) args.push('--model', model)
    return { program: python, args }
  }

  private async runEngine(engine: 'openai' | 'whisper-cpp' | 'custom', wavPath: string, workDir: string): Promise<string> {
    const timeout = this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS
    if (engine === 'custom') {
      const spec = await this.customSpec()
      const args = spec.args.map(arg => arg.replaceAll('{file}', wavPath).replaceAll('{out}', join(workDir, 'out')))
      await runProcess(spec.program, args, timeout)
      return readFirstTxt(workDir)
    }
    if (engine === 'openai') {
      const program = (await findCommand('whisper')) ?? (await findCommand('mlx_whisper'))
      if (program === undefined) throw new Error('STT: whisper CLI not found')
      const args = program.endsWith('mlx_whisper')
        ? [wavPath, '--model', this.config.model, '--output-format', 'txt', '--output-dir', workDir, '--verbose', 'False']
        : [wavPath, '--model', this.config.model, '--output_format', 'txt', '--output_dir', workDir, '--verbose', 'False']
      await runProcess(program, args, timeout)
      return readFirstTxt(workDir)
    }
    // whisper.cpp
    const program = await findCommand('whisper-cli')
    if (program === undefined) throw new Error('STT: whisper-cli not found')
    const model = await findWhisperCppModel(this.config.model)
    if (model === undefined) {
      throw new Error('STT: whisper.cpp model not found for "' + this.config.model + '" (set stt.model to an absolute .bin path)')
    }
    const outBase = join(workDir, 'out')
    await runProcess(program, ['-m', model, '-f', wavPath, '-otxt', '-of', outBase], timeout)
    return readFirstTxt(workDir)
  }
}

/** Read the first .txt transcript produced in a work dir. */
async function readFirstTxt(dir: string): Promise<string> {
  const entries = await readdir(dir)
  const txt = entries.find(name => name.endsWith('.txt'))
  if (txt === undefined) return ''
  const content = await readFile(join(dir, txt), 'utf8')
  return content.trim()
}

/** Convenience: transcription result for the bridge. */
export function transcriptLabel(text: string): string {
  return text !== '' ? '（语音转写：' + text + '）' : ''
}
