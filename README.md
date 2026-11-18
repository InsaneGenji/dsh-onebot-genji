# dsh-onebot-genji

把 QQ 接入 DeepSeek Harness 的通道插件（OneBot 11），从 `dsh-onebot-qq@0.11.0` 分叉而来。

本分叉由 **InsaneGenji** 维护，在上游基础上加自己需要的东西；想装上游原版请去 https://github.com/mario841859784/dsh-onebot ，上游完整文档见 [`README.upstream.md`](./README.upstream.md)。

## 这个分叉打算加什么

- 回合形式掷骰：每个回合按概率决定这一轮是回文字、语音条还是表情包，概率做成设置项
- 双发闸：一个回合里工具已经发过文本，回合末的正文不再重复发一遍
- 引用的合并转发展开：被引消息本身是合并转发时展开成可读内容，而不是只剩 `[合并转发]` 占位
- 正文气泡切分：长回复按换行和句子切成多条独立消息，而不是一堵墙

> 上面几项目前还没合进代码——仓库还停在上游 0.11.0 的原样，先立个架子。

## 安装与配置

与原版完全一致，见 [`README.upstream.md`](./README.upstream.md)。

## 许可证

BSD-3-Clause，版权归原作者所有，见 [`LICENSE`](./LICENSE)。
