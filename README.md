# dsh-onebot-genji

把 QQ 接入 DeepSeek Harness 的通道插件（OneBot 11），从 `dsh-onebot-qq@0.11.0` 分叉而来。

本分叉由 **InsaneGenji** 维护，在上游基础上加自己需要的东西；想装上游原版请去 https://github.com/mario841859784/dsh-onebot ，上游完整文档见 [`README.upstream.md`](./README.upstream.md)。

## 和原版（dsh-onebot-qq）的区别

只列本分叉**新加**的功能；安装、配置、连接 NapCat 的方式跟原版完全一致，见 [`README.upstream.md`](./README.upstream.md)。

| 功能 | 说明 |
| --- | --- |
| **自带语音转写桥** | `lib/stt_cli.py` 打进包里，`sttEngine: auto` 探不到 whisper 时自动用它（只要 Python + `faster-whisper`），不用自己配脚本 |
| **表情包库** | 收到的新图自动进「未审核」；设置页「表情包」页签里看图、审核、撤回、删除、多选上传。审核时才让模型看图写描述和标签，不点不跑、不占显存 |
| **主动搭话** | 内置在插件里（`lib/proactive.js`），按空闲时长、间隔、每日上限、安静时段自己找话题，聊完还能补一句；开关和阈值全在设置页「行为 → 私聊」，生成走当前会话模型 |
| **回合形式掷骰** | 每个回合按概率决定这一轮用文字、语音条还是表情包；语音/表情的开关与概率都是设置项（默认 10% / 39%） |
| **群聊上下文** | 被 @ 或叫到唤醒词时，自动带上群里最近 N 条消息（「参考上下文条数」，默认 3，0 = 不带），被门控挡下的消息不会丢 |
| **唤醒词合并** | 原版分「用户唤醒词 / 他人唤醒词」两套名单，这里合成一个「唤醒词」列表：群里任何人命中都算叫到机器人 |
| **引用合并转发展开** | 被引的消息本身是合并转发时展开成可读内容，而不是只剩 `[合并转发]` 占位 |
| **会话恢复重试** | 插件热重载时原版会「恢复失败 → 退休旧会话 → 新建」，一个聊天裂成两个会话；这里带 0.7s / 1.5s / 3s 三次重试，等旧会话把手上那轮收完 |
| **设置页重做** | 中文标签 + 分组分区（连接 / 权限 / 行为 / 表情包 / 会话 / 媒体 / 诊断），数字项统一「≥0 的整数」校验，用不到的项（旁观、强制会话 ID、新会话智能体预设等）已隐藏 |

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
