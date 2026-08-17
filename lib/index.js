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
import { modelDir, modelReady, transcribeWavBuffer, disposeRecognizer, diagnose } from './transcriber.js';
import { downloadModel, modelStatus, getDownloadState, abortDownload } from './model.js';
import { probeResampler } from './arch.js';

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
        });
        return;
      }

      if (req.method === 'GET' && suffix === '/model/status') {
        json(res, 200, { ok: true, ...(await modelStatus(modelDir(undefined, config.modelDir))) });
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
        });
        promise.catch(() => { /* 状态已记录在 downloadState */ });
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
        const text = await doTranscribe(buffer, dir);
        json(res, 200, { ok: true, text });
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
      };
    },
    'dsh-voice-local: transcribe route + download lifecycle',
  );
}
