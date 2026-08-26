/**
 * dsh-voice-local host half（server 插件）：
 * 接收浏览器上传的 WAV → SenseVoice 本地离线转写 → 返回文本。
 *
 * 路由（prefix /dsh-voice-local/v1）：
 *   GET  /health          → 插件/原生/模型状态
 *   GET  /model/status    → 模型目录/文件明细 + 后台下载进度
 *   POST /model/download  → 启动后台模型下载（幂等，立即返回）
 *   POST /transcribe      → body 为 WAV 二进制，返回 { text }
 *   GET  /diagnose        → 原生模块/重采样器探测
 *
 * 所有路由只允许 loopback 或 trustedHosts 来源访问。
 */
import { modelDir, modelReady, readWavSamples, transcribeSamples, disposeRecognizer, diagnose } from './transcriber.js';
import { downloadModel, modelStatus, getDownloadState, abortDownload, filterModelsInfo } from './model.js';
import { probeResampler } from './arch.js';
import { filterPipeline, audioFilterModelStatus, audioFilterRuntimeStatus, disposeAudioFilter } from './audio-filter.js';
import { guardTranscript } from './text-guard.js';

export const name = 'dsh-voice-local';
export const inject = ['webServer', 'loader'];

const API_ROOT = '/dsh-voice-local/v1';
const MAX_BODY_BYTES = 24 * 1024 * 1024; // 24 MiB，足够 ~12 分钟 16kHz PCM16 mono

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function error(res, status, code, message, extra = undefined) {
  json(res, status, { ok: false, error: { code, message, ...extra } });
}

function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function authority(value) {
  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
}

function canonicalAuthority(raw, parsed) {
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${raw}`).port;
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function trustedRequest(req, trustedHosts) {
  const host = header(req.headers, 'host');
  if (host === undefined) return false;
  const parsedHost = authority(host);
  if (parsedHost === undefined) return false;
  const listed = trustedHosts.some((entry) => {
    const parsed = authority(entry);
    if (parsed === undefined) return false;
    return canonicalAuthority(entry, parsed) === parsed.hostname
      ? parsed.hostname === parsedHost.hostname
      : parsed.host === parsedHost.host;
  });
  if (!isLoopback(parsedHost.hostname) && !listed) return false;
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(req.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === parsedHost.host;
  } catch {
    return false;
  }
}

function sourceTrustedHosts(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name !== '@deepseek-ai/dsh-client-connection') continue;
    const value = entry.fiber?.config?.trustedHosts;
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  }
  return [];
}

async function readBody(req, maxBytes) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`音频过大（超过 ${maxBytes} 字节）`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export function apply(ctx, config = {}) {
  // 测试 seam：允许注入 modelReady / transcriber / modelDownload，使路由测试不依赖真实模型。
  const isModelReady = typeof config.modelReady === 'function'
    ? config.modelReady
    : (dir) => modelReady(dir);
  const doTranscribe = typeof config.transcriber === 'function'
    ? config.transcriber
    : (buffer, dir) => transcribeWavBuffer(buffer, dir);
  const doDownload = typeof config.modelDownload === 'function'
    ? config.modelDownload
    : (opts) => downloadModel(opts);

  // ---- 噪声过滤配置（design.md D7；全部可选有默认，零配置可用）----
  const vadEnabled = config.vad?.enabled !== false;
  const denoiseEnabled = config.denoise?.enabled !== false;
  const minSpeechMs = Number.isFinite(config.vad?.minSpeechMs) ? config.vad.minSpeechMs : 400;
  const debug = config.debug === true;

  // 守门编排测试 seam：decoder/audioFilter/recognizer/textGuard 可分别注入假件；
  // 生产路径缺省使用真实实现。旧 config.transcriber seam 保持兼容（见 /transcribe）。
  const doDecode = typeof config.decoder === 'function'
    ? config.decoder
    : (buffer) => Promise.resolve(readWavSamples(buffer));
  const doAudioFilter = typeof config.audioFilter === 'function'
    ? config.audioFilter
    : (samples, opts) => filterPipeline(samples, opts);
  const doRecognizeSamples = typeof config.recognizer === 'function'
    ? config.recognizer
    : (samples, dir) => transcribeSamples(samples, dir);
  const doGuardText = typeof config.textGuard === 'function'
    ? config.textGuard
    : guardTranscript;

  /** /health 过滤器组件状态聚合（配置开关 × 文件就绪 × 运行时状态）。 */
  async function filtersHealthSnapshot() {
    const [files, runtime] = await Promise.all([audioFilterModelStatus(), Promise.resolve(audioFilterRuntimeStatus())]);
    const overlay = (enabled, fileReady, rtState) => {
      if (!enabled) return 'disabled';
      if (rtState === 'error' || rtState === 'degraded') return 'error';
      return fileReady ? 'ready' : 'missing';
    };
    return {
      vad: {
        enabled: vadEnabled,
        state: overlay(vadEnabled, files.vad, runtime.vad.state),
        degradedRuns: runtime.degradedRuns,
      },
      denoiser: {
        enabled: denoiseEnabled,
        state: overlay(denoiseEnabled, files.denoiser, runtime.denoiser.state),
      },
    };
  }

  const route = async (req, res) => {
    if (!trustedRequest(req, sourceTrustedHosts(ctx))) {
      error(res, 403, 'forbidden', '请求未通过 DSH Host/Origin 信任校验');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const suffix = url.pathname.slice(API_ROOT.length);
    try {
      if (req.method === 'GET' && suffix === '/health') {
        const dir = modelDir(undefined, config.modelDir);
        const state = await diagnose();
        json(res, 200, {
          ok: true,
          plugin: name,
          protocol: 1,
          model: {
            ready: await isModelReady(dir),
            dir,
            download: getDownloadState(),
          },
          native: {
            ok: state.native.addonLoads,
            arch: state.native.arch,
            platform: state.native.platform,
            wanted: state.native.wanted,
          },
          filters: await filtersHealthSnapshot(),
        });
        return;
      }

      if (req.method === 'GET' && suffix === '/model/status') {
        const [status, filters] = await Promise.all([
          modelStatus(modelDir(undefined, config.modelDir)),
          filterModelsInfo(),
        ]);
        json(res, 200, { ok: true, ...status, filters });
        return;
      }

      if (req.method === 'POST' && suffix === '/model/download') {
        const current = getDownloadState();
        if (current.status === 'downloading') {
          json(res, 200, { ok: true, started: false, download: current });
          return;
        }
        const promise = doDownload({
          modelDir: config.modelDir,
          modelUrl: config.modelUrl,
          mirrorUrl: config.mirrorUrl,
          mirrors: config.mirrors,
          sha256: config.sha256,
          modelSha256: config.modelSha256,
          tokensSha256: config.tokensSha256,
          retries: config.retries,
          // 首次使用自动后台下载时顺带补齐过滤器小模型（CHANGELOG 0.3.0 承诺）；
          // 单个失败隔离记录在 downloadState.filters，不影响主模型可用性。
          filters: true,
        });
        promise
          .then((result) => {
            // 过滤器模型从缺失变为就绪后，重置守门单例缓存的 missing/error 结论，
            // 让下一段音频无需重启即走完整管线（见 audio-filter ensureVad 重试语义）。
            if (result?.filters && Object.values(result.filters).some((f) => f?.ok)) {
              disposeAudioFilter();
            }
          })
          .catch(() => { /* 状态已记录在 downloadState */ });
        json(res, 202, { ok: true, started: true, download: getDownloadState() });
        return;
      }

      if (req.method === 'GET' && suffix === '/diagnose') {
        json(res, 200, { ok: true, ...probeResampler() });
        return;
      }

      if (req.method === 'POST' && suffix === '/transcribe') {
        const dir = modelDir(undefined, config.modelDir);
        if (!(await isModelReady(dir))) {
          const download = getDownloadState();
          error(res, 503, 'model-not-ready', 'SenseVoice 模型未就绪：请先调用 /model/download 完成下载', { download });
          return;
        }
        const buffer = await readBody(req, MAX_BODY_BYTES);
        if (buffer.length === 0) {
          error(res, 400, 'empty-audio', '未收到音频数据');
          return;
        }

        // 兼容 seam：注入 config.transcriber 时走旧的"整段 buffer → 文本"路径
        // （既有集成测试与外部嵌入方依赖此契约，不经过守门编排）。
        if (typeof config.transcriber === 'function') {
          const text = await doTranscribe(buffer, dir);
          json(res, 200, { ok: true, text });
          return;
        }

        // 生产编排：解码一次 → GTCRN 降噪(可选) → Silero VAD 守门 → SenseVoice → 幻觉兜底。
        // 响应契约恒为 { ok, text }（design D7）；meta 仅 debug 开启时附加。
        let decoded;
        try {
          decoded = await doDecode(buffer);
        } catch (cause) {
          error(res, 400, 'decode-failed', `音频解码失败：${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        if (!decoded.samples || decoded.samples.length === 0) {
          json(res, 200, { ok: true, text: '' });
          return;
        }

        const filterOpts = { vadEnabled, denoiseEnabled, minSpeechMs };
        let filtered;
        try {
          filtered = await doAudioFilter(decoded.samples, filterOpts);
        } catch (cause) {
          // 双保险：seam/管线外的异常同样按 fail-open 处理。
          filtered = { speech: true, samples: decoded.samples, bypass: true, speechMs: null, denoised: false };
        }

        const metaBase = {
          guarded: false,
          denoised: filtered.denoised === true,
          speechMs: Number.isFinite(filtered.speechMs) ? filtered.speechMs : null,
          bypass: filtered.bypass === true,
        };

        if (filtered.speech !== true) {
          // 权威拦截：非语音段不送识别（spec「环境噪声人声守门」）。
          json(res, 200, debug ? { ok: true, text: '', meta: { ...metaBase, guarded: true } } : { ok: true, text: '' });
          return;
        }

        const rawText = await doRecognizeSamples(filtered.samples, dir);
        const text = doGuardText(rawText);
        json(res, 200, debug ? { ok: true, text, meta: metaBase } : { ok: true, text });
        return;
      }

      error(res, 404, 'not-found', '未知的 dsh-voice-local 端点');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      let code = /模型未就绪/.test(message) ? 'model-not-ready' : 'transcribe-failed';
      let extra;
      if (cause?.code === 'native-module-missing') {
        code = 'native-module-missing';
        extra = { fix: cause.fix, arch: cause.nativeStatus?.arch, wanted: cause.nativeStatus?.wanted };
        error(res, 500, code, 'sherpa-onnx 原生模块缺失，见 fix 字段', extra);
        return;
      }
      if (cause?.debug !== undefined) {
        error(res, 500, code, message, { debug: cause.debug });
        return;
      }
      error(res, 400, code, message);
    }
  };

  ctx.effect(
    () => {
      const unregister = ctx.webServer.register({ kind: 'prefix', path: API_ROOT, handler: route });
      return () => {
        try {
          if (typeof unregister === 'function') unregister();
        } catch { /* noop */ }
        abortDownload();
        disposeRecognizer();
        disposeAudioFilter();
      };
    },
    'dsh-voice-local: transcribe route + download lifecycle',
  );
}
