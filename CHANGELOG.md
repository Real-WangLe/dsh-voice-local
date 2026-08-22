# Changelog

## 0.2.0

### 新增

- **键盘输入自动关闭麦克风**：麦克风旁的 **⋮ 菜单**提供开关（默认开启）。开启时录音中打字 / 粘贴 / 中文输入法 / 撤销重做会立即停止录音，避免语音混入正在编辑的文字；关闭后保留边说边打工作流，转写跟随光标插入。
- **光标处语音插入**：识别文本不再固定追加到草稿末尾，而是插入当前光标位置，光标自动移到新文本之后；在句中边说边打更顺手，中英数字边界自动补空格。
- **提问卡片语音输入**：DSH 的提问卡片（AskUserQuestion）自定义回答区新增麦克风入口，可以语音回答；翻页自动跟随、提交中不写入、宿主结构变化时安全降级。
- **接管自动停止**：主输入框录音中如果弹出提问 / 审批 / 计划审阅卡片，自动停止录音并把尾段写入草稿，避免“隐形录音”。

### 改进

- 双入口共享统一录音 / 断句 / 转写 / 队列引擎，同一时刻至多一个目标录音，切换更顺滑。
- 修复切到设置页等界面时语音被写到草稿最开头的问题。
- 修复问题卡片录音被主输入框接管自停误杀的问题。
- 语音设置菜单改为点击 **⋮** 打开，从右上角弹出，不再遮挡输入区。
- CI 在单测 / 集成基础上新增浏览器端 e2e 测试；`doctor` 增加提问卡锚点检查（`q-anchor`）。

## 0.1.0

- Adapted in part from the community package `dsh-voice-input` (source attribution in README and LICENSE).
- Add standard DSH bundle patch (`dsh.bundle.patch`) and plugin id `dsh-voice-local`.
- Replace ScriptProcessor with AudioWorklet capture.
- Add browser-side silence detection for sentence-level real-time transcription.
- Add serialized segment append with synchronous latest-draft read (race-safe).
- Add background model download with progress, mirror URL list, SHA256 verification, retry, and offline manual import support.
- Add loopback/trustedHosts protected routes under `/dsh-voice-local/v1`.
- Add unit, route integration, model manager tests, and real-model smoke lane.
- Add npm publish + GitHub Actions release pipeline.
