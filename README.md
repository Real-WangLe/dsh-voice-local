# dsh-voice-local

DeepSeek Harness（dsh）Web UI 本地语音输入插件。

- **全程本地离线**：录音与转写都在本机完成，**音频不出本机**、不依赖云端 API/API Key。
- **引擎**：SenseVoice（sherpa-onnx-node，CPU 推理），支持中文自动标点及中/英/日/韩/粤多语言。
- **句子级实时**：浏览器端静音检测断句，说一句自动回填一句，可继续说话；识别文本按光标位置插入。
- **安全**：宿主路由只允许 loopback / trustedHosts 访问，非本机请求返回 403。
- **可发布**：标准 DSH bundle（`dsh.bundle.patch`），`dsh plugin --profile web add dsh-voice-local` 一行安装。

## 安装

```bash
dsh plugin --profile web add dsh-voice-local
# 重启 dsh web 后生效
```

首次点击麦克风会自动在后台下载 SenseVoice 模型（约 230MB），并显示进度提示；下载完成后即可开始录音。

## 手动下载 / 离线导入

如果自动下载在你的网络环境下较慢，可以手动下载模型文件后放到固定目录，插件检测到后不会再触发下载：

```bash
mkdir -p ~/.dsh/voice/sensevoice
cd ~/.dsh/voice/sensevoice
# 用浏览器/IDM/迅雷等工具下载官方 tar.bz2 并解压：
#   https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
# 解压后确认目录中有：
#   model.int8.onnx
#   tokens.txt
```

也可以使用 `DSH_VOICE_MIRROR_URL` 或 `DSH_VOICE_MIRRORS` 指定更快镜像后运行：

```bash
DSH_VOICE_MIRROR_URL="https://your-mirror/...tar.bz2" node tools/download-model.mjs
```

## 使用

1. 打开任意会话，点击输入框工具行麦克风按钮开始录音。
2. 说话；检测到停顿时自动转写并**插入输入框光标位置**（光标在末尾时等价追加），光标随新文本后移。
3. 再次点击麦克风按钮停止录音，未定稿的剩余语音会完成最后一次转写。
4. 识别文本**不会自动发送**，发送前可编辑。

### 键盘自停（默认开启）

麦克风旁的 **⋮ 按钮** 打开语音设置菜单（右上角弹出），内含说明与开关「键盘输入自动关闭麦克风」：

- **开启（默认）**：录音期间打字 / 粘贴 / 中文输入法 / 撤销重做会立即停止录音（未定稿尾段丢弃，避免迟到转写插进手打内容之后）。
- **关闭**：保留 v1 边说边打工作流，录音不中断，转写跟随光标插入。

提问卡片的回答框、审批/计划审阅卡弹出时同样适用自动停止逻辑。

另外，主输入框录音中若弹出提问 / 审批 / 计划审阅卡片，会自动停止录音并把尾段落回草稿，避免“隐形录音”。

### 提问卡片语音回答

agent 通过 ask-user_question 提问时，自定义回答输入区旁会出现同一枚麦克风：说话即插入当前题回答框光标处，不改变已选项、不自动提交；翻页自动跟随。若 DSH 升级后入口消失（锚点变化），插件静默降级不影响卡片本身，可用 `npm run doctor` 查看 `q-anchor` 诊断。

## 配置

可选环境变量：

| 变量 | 说明 | 默认 |
|:--|:--|:--|
| `DSH_HOME` | dsh 数据目录，模型存到 `$DSH_HOME/voice/sensevoice` | `~/.dsh` |
| `DSH_VOICE_MODEL_DIR` | 模型目录覆盖 | 默认目录 |
| `DSH_VOICE_MODEL_URL` | 模型下载主 URL | 官方 GitHub release |
| `DSH_VOICE_MIRROR_URL` | 单个镜像 URL（最先尝试） | 无 |
| `DSH_VOICE_MIRRORS` | 逗号分隔的镜像 URL 列表（按顺序尝试） | 内置 ghfast.top/gh-proxy.com + hf-mirror 直连文件 |
| `DSH_VOICE_MODEL_SHA256` | 模型归档 SHA256（可选强校验） | 内置值（若已发布） |
| `DSH_VOICE_MODEL_FILE_SHA256` | 直连文件模式下 model.int8.onnx 的 SHA256（可选） | 无 |
| `DSH_VOICE_TOKENS_SHA256` | 直连文件模式下 tokens.txt 的 SHA256（可选） | 无 |

也可以在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- insert:
    - id: dsh-voice-local
      name: dsh-voice-local
      config:
        modelUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/...'
        mirrorUrl: 'https://your-mirror/...'          # 单个首选镜像
        mirrors: ['https://mirror-a/...', 'https://mirror-b/...']  # 按顺序尝试
        modelDir: '/absolute/path/to/model'
        sha256: '<sha256>'
```

## 宿主路由

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/dsh-voice-local/v1/health` | 插件/原生模块/模型状态 |
| GET | `/dsh-voice-local/v1/model/status` | 模型文件与下载进度 |
| POST | `/dsh-voice-local/v1/model/download` | 启动后台模型下载 |
| POST | `/dsh-voice-local/v1/transcribe` | 上传 WAV，返回识别文本 |
| GET | `/dsh-voice-local/v1/diagnose` | 原生模块/重采样器诊断 |

所有路由仅允许本机回环或 DSH `trustedHosts` 来源访问。

## 诊断

```bash
node scripts/doctor.mjs            # 完整诊断
node scripts/doctor.mjs --json     # 机器可读
node tools/download-model.mjs      # 手动下载模型
```

## 开发

```bash
npm install
npm run build        # 复制 lib/ -> dist/
npm test             # 单元 + 路由集成测试
node scripts/smoke.mjs <wav> [expected.txt]   # 真实模型慢速冒烟
```

## License

本项目采用 MIT License。

### 致谢

本项目部分改编自社区插件包 `dsh-voice-input`。参考包元数据标注的来源为 `fuzhailv`，原始实现采用 MIT License。

本项目保留了原始 MIT 许可声明，并对 SenseVoice 转写封装、原生模块诊断、模型管理、宿主路由以及浏览器端录音与断句逻辑进行了改造和扩展。

由于目前无法核验原始参考包的公开仓库地址，本项目不附未经确认的外部链接。
