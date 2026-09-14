# Changelog

## 0.4.0

### 修复

- **人声守门对“首次安装即 0.3.0”的用户 100% 失效（P0 回归）**：`corePipeline` 把整段音频一次性交给 Silero VAD，违反上游 `AcceptWaveform` 的“每次约一个 window（512 样本）”契约，语音起点被锚定在缓冲区尾部，判定值塌缩为常数（与真实语音长度无关）→ 每段都被权威拦截、识别器从不被调用、界面永远不出字。现改为按 `VAD_WINDOW_SIZE = 512` 分块喂入（含尾部余数）并在末尾 `flush()` 弹出未闭合语音段；实测同一 7.01s fixture：修复前整段喂入恒判 **314ms**（拦截），修复后 **3442ms**（3 段 `[1958,774,710]`，放行），其前 3s 切片 **2074ms**，纯稳态噪声仍判 **0ms**（只修“漏”、不引入“误”）。0.2.x 升级用户此前因从未触发过滤器下载而走 fail-open 才显得正常，这正是“只有新用户报障”的原因。
- **GTCRN 降噪模型下载地址错配**：0.3.0 起指向 `asr-models` 标签，直连与镜像恒 404，降噪能力从未在真实环境生效。现按发布标签分区（VAD 保持 `asr-models`，GTCRN 改为 `speech-enhancement-models`）；某资产全部候选地址失败时，错误信息携带每条候选 URL 与各自失败原因。
- **存量用户的过滤器资产自动补齐**：主模型已就绪但过滤器资产缺失或为 0 字节时，录音前 fire-and-forget 触发一次幂等补下载，不重复下载主模型、不阻塞录音。
- **发送手势不停麦**：录音中在主输入框按 Enter/Ctrl+Enter 发送后，麦克风仍在录、迟到的识别文本落进新建空草稿。现在发送手势立即停麦并丢弃未定稿尾段，且与“键盘输入自动关闭麦克风”开关无关；`Shift+Enter` 与提问卡回车不触发。
- **识别文本含控制字符**：写入前去除回车符、把换行折叠为空格。
- **快捷键主键匹配对修饰键/键盘布局敏感**：只比 `event.key` 会让 macOS 上 `Option+V`（`event.key` 是 `'√'`）与 AltGr 布局下的组合“绑得上却按不出来”；改为以物理键位 `event.code`（KeyV/Digit1/Space/F11）优先推导主键，`event.key` 仅作回退。

### 新增

- **语音快捷键**：默认 **Ctrl/Cmd+Alt+V**（macOS **⌘⌥V**，V for Voice）。触发语义与点击麦克风完全一致（空闲开始 / 录音中停止并冲刷 / 启动中取消 / 转写或下载中忽略）；**停止不依赖焦点**。⋮ 菜单内新增「快捷键」行，行内直接捕获改绑（Esc 取消、✕ 恢复默认、保留键当场拒绝、Space 系等冲突组合允许绑定但提示），localStorage 持久化；键名大小写不敏感。主键以**物理键位**（event.code）优先匹配，macOS Option 组合与非美式布局下同样可用。默认键位由原计划的 `Ctrl+Shift+Space` 改为一组双修饰键 + 字母，因为手测发现 `Ctrl+Shift+Space` 被 Chrome 翻译类扩展（Google Translate 等）默认占用并吞掉按键，表现为"按了没反应"。
- **快捷键目标按焦点解析**：提问卡回答框 → 该卡；主输入框或页面无焦点 → 主输入框；其他可编辑控件 → 不触发、不劫持按键。按钮与快捷键共用同一份“当前可否开始录音”判定（`canStart`），接管卡片弹出或提交事务状态下不会“闪一下”。
- **守门可观测面**：`/health` 暴露 `judgedRuns` / `emptyRuns` / `recentSpeechMs`（最近 10 次）与按组件的 `runs` / `errors` / `lastError`；`debug: true` 时 `/transcribe` 的 `meta` 新增 `gateReason` 与 `denoiseFailed`。守门短路响应在保持 `{ ok, text }` 结构的前提下**无需开 debug** 即附带 `gateReason`，客户端连续两段判空时给出一次可读提示。
- **插入安全**：目标处于输入法组合中时写入延后到组合结束（有界 1s，超时或期间进入提交事务状态则丢弃该段）；明确“程序化写入不触发宿主发送/提交手势”并有断言回归；新增只读审计钩子 `window.__dshVoiceLocalDebug`（默认关闭，供 issue 复现时 dump）。

### 测试与发布

- 新增跨调用累计语义的假 VAD（旧 fake“一次调用即一段”，对“一次喂多少”天然免疫，0.3.0 的 P0 正是从这个缺口漏出去的）+ 喂入契约断言（每次调用 ≤ 512、按序拼接覆盖完整输入、调用次数 > 1）。
- 新增真模型守门回归 fixture `test/fixtures/voice-zh-16k.wav`（维护者自录素材全长转码的 16k 单声道 PCM16，112,085 样本 / 219KB）与“两个不同长度切片判定值不相等且均高于门限”的形状断言；`scripts/smoke.mjs` 无参默认使用该 fixture，慢速 lane 在 `v*` tag / 发布前自动触发。
- e2e 新增快捷键、目标解析、捕获态与 Esc 分层、回车自停、IME 延后写入、程序化写入不触发发送等断言。

### 迁移与回滚

- 已下载 `silero_vad.onnx` 的 0.3.0 用户无需重新下载，修复只改变喂数据方式；GTCRN 缺失会被自动补齐。
- **回滚到 0.3.0 时必须一并处理已补齐的 `~/.dsh/voice/vad/silero_vad.onnx`**：0.3.0 的单次大 buffer 喂入 + 该资产存在 = 100% 拦截。要么删除该文件，要么设置 `vad.enabled: false`。

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
