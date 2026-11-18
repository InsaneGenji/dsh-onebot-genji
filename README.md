# dsh-onebot-genji

把 QQ 接入 DeepSeek Harness 的通道插件（OneBot 11），从 `dsh-onebot-qq@0.11.0` 分叉而来。

本分叉由 **InsaneGenji** 维护，在上游基础上加自己需要的东西；想装上游原版请去 https://github.com/mario841859784/dsh-onebot ，上游完整文档见 [`README.upstream.md`](./README.upstream.md)。

## 这个分叉打算加什么

- 回合形式掷骰：每个回合按概率决定这一轮是回文字、语音条还是表情包，概率做成设置项
- 双发闸：一个回合里工具已经发过文本，回合末的正文不再重复发一遍
- 引用的合并转发展开：被引消息本身是合并转发时展开成可读内容，而不是只剩 `[合并转发]` 占位
- 正文气泡切分：长回复按换行和句子切成多条独立消息，而不是一堵墙
- 自带语音转写桥：`lib/stt_cli.py` 打进包里，`sttEngine: auto` 探不到 whisper 时自动用它（只要求 Python + `faster-whisper`），不用用户自己配脚本

> 自带语音转写桥已经合入代码；其余几项还在做。

## 安装与配置

与原版完全一致，见 [`README.upstream.md`](./README.upstream.md)。

## 语音转写（插件自带的桥）

入站语音（QQ 的 SILK，或普通音频）先转成 16 kHz 单声道 WAV，再交给转写引擎。引擎按设置里的 `sttEngine` 选：

- **`auto`（默认）**：先找 PATH 上的 `whisper-cli` / `whisper` / `mlx_whisper`；一个都没有就用插件自带的桥——`lib/stt_cli.py` + PATH 上的 `python` / `python3` / `py`。装完插件不需要另外准备脚本。
- **`custom`**：用 `sttCommand` + `sttArgs` 自己指定；这两项留空同样回落到自带的 `lib/stt_cli.py`（内置参数模板是 `{file} {out} --model <模型>`）。
- **`openai` / `whisper-cpp`**：调用同名 CLI，需要自己装。

自带桥只依赖一个 Python 包：

```
pip install faster-whisper      # 首次运行会自动下载模型（small 约 480 MB）
```

PATH 上既没有 whisper 可执行文件、也没有可用的 Python 时，语音消息降级成 `[语音]` 占位，其它功能不受影响。

自带桥认这几个环境变量：`DS_STT_SERVER`（常驻转写服务地址，默认 `http://127.0.0.1:9891/transcribe`，设成空串则禁用）、`DS_STT_MODEL`（默认 `small`）、`DS_STT_CACHE`（模型缓存目录）、`DS_STT_LANG`（默认 `zh`）。

## 许可证

BSD-3-Clause，版权归原作者所有，见 [`LICENSE`](./LICENSE)。
