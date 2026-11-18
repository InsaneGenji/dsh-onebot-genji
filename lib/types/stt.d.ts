/**
 * Voice transcription: SILK v3 (magic-number detected) or ffmpeg → WAV, then
 * a whisper engine (openai-whisper CLI, whisper.cpp whisper-cli, or a custom
 * command) produces the transcript. All subprocess work is queued, bounded by
 * a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */
/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
    enabled: boolean;
    engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    /** Program path/name for the custom engine. */
    command: string;
    /** argv template for the custom engine; {file} and {out} are substituted. */
    args: string[];
    /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
    model: string;
    /** Per-transcription timeout in ms. */
    timeoutMs: number;
}
/**
 * 判断文件头是不是 SILK v3。
 *
 * QQ 语音落地时扩展名常被写成 `.mp3`，内容其实是协议端 `get_record`
 * 兜底返回的原始 SILK——ffmpeg 按 mp3 解必然失败（表现为一直只有
 * `[语音]`）。协议端有的会把帧类型字节一起落盘，所以头部允许
 * 0x02 / 0x03 前缀。
 * @param head - 文件前若干字节（>= 10 字节即可）。
 */
export declare function isSilkData(head: Uint8Array): boolean;
/** 把 16-bit 单声道 PCM 包成最小 WAV（44 字节头），引擎侧都认这个。 */
export declare function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Buffer;
/**
 * SILK → 16 kHz 单声道 WAV 之外的「引擎输入」准备。
 *
 * 命中 SILK 魔数时用 `silk-wasm`（纯 wasm，无 native 依赖）解码成 PCM，
 * 再包成 WAV 交给引擎；解码失败就返回 false，让调用方回落到原来的
 * ffmpeg 路径——宁可多试一次，也不要因为解码器不认识某种 SILK 变体
 * 就把整条语音丢掉。
 * @returns true 表示 `outPath` 已写好可用的 WAV。
 */
export declare function writeSilkWav(bytes: Uint8Array, outPath: string): Promise<boolean>;
/**
 * Detect a command on PATH by scanning each dir for an executable match
 * (A8: no shell involved, so the configured name is never shell-interpreted;
 * builtins/aliases stop being visible — callers only need real binaries).
 */
export declare function findCommand(name: string): Promise<string | undefined>;
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
export declare function findPython(): Promise<string | undefined>;
/**
 * Voice transcription service. One instance per plugin; calls are serialized
 * through a queue so concurrent voice messages cannot stack CPU-bound
 * whisper processes.
 */
export declare class Transcriber {
    private readonly config;
    private queue;
    private ffmpegChecked;
    private pythonChecked;
    constructor(config: SttConfig);
    /** Whether transcription is enabled by config. */
    get enabled(): boolean;
    /** 缓存 Python 探测结果（undefined=还没查，null=明确没有）。 */
    private pythonBinary;
    /**
     * Transcribe a voice file. SILK v3 input is decoded to PCM/WAV directly;
     * everything else is converted to 16 kHz mono WAV with ffmpeg; the WAV is
     * then handed to the selected engine.
     * @param filePath - absolute path of the downloaded voice file.
     * @returns the transcript text (trimmed), or '' when the file is silent.
     * @throws when transcription is impossible (missing tools, timeout...).
     */
    transcribe(filePath: string): Promise<string>;
    private transcribeNow;
    private resolveEngine;
    /** custom 引擎真正要跑的程序与参数（没配就用插件自带的 stt_cli.py）。 */
    private customSpec;
    private runEngine;
}
/** Convenience: transcription result for the bridge. */
export declare function transcriptLabel(text: string): string;
