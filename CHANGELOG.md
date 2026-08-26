# Changelog

## 0.3.0

### 新增

- **噪声全链路过滤**：环境杂音不再污染草稿。浏览器端静音检测升级为自适应门控（噪声底跟踪 + 双门限迟滞 + 触发前 250ms 回带 + 最短人声门）；宿主端新增 GTCRN 神经降噪（可选）与 Silero VAD 人声守门——累计人声不足的段不送识别、直接不落笔。
- **文本幻觉兜底**："谢谢观看。"类识别残留、单字符超长重复、孤立标点在返回前被规则拦空，正常中英文直通。
- **过滤器模型管理**：Silero VAD（~2.2MB）与 GTCRN（<2MB）随首次使用自动后台下载，支持镜像；下载完成即生效、无需重启；`/health` 与 `/model/status` 如实暴露可用/缺失/降级状态。

### 改进

- **fail-open 降级语义**：过滤器模型缺失或推理异常时自动旁路，听写主链路永不受影响；降噪可经配置一键关闭。
- **并发安全**：recognizer / VAD / 降噪器三处懒加载统一互斥，消除并发首请求重复加载模型的竞态。
- 麦克风采集补齐 `autoGainControl`。

### 模型资产

- 新增运行时下载：`silero_vad.onnx`、`gtcrn_simple.onnx`（同 sherpa-onnx 官方 release，镜像机制与 SenseVoice 一致；模型依旧不打包进 npm 包）。

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
