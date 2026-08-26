import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name } from '../../lib/index.js';

function createMockCtx() {
  let handler = null;
  let cleanup = null;
  const ctx = {
    effect(fn) {
      cleanup = fn();
    },
    webServer: {
      register({ handler: h }) {
        handler = h;
        return () => { handler = null; };
      },
    },
    loader: {
      entries() {
        return [{
          options: { name: '@deepseek-ai/dsh-client-connection' },
          fiber: { config: { trustedHosts: ['127.0.0.1:3080'] } },
        }];
      },
    },
  };
  return { ctx, getHandler: () => handler, getCleanup: () => cleanup };
}

function request(method, path, { body, headers = {} } = {}) {
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', ...headers },
  };
  if (body !== undefined) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    req[Symbol.asyncIterator] = async function* () { yield buf; };
  }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = typeof chunk === 'string' ? chunk : (chunk?.toString() ?? '');
    },
  };
  return { req, res };
}

async function call(handler, method, path, opts) {
  const { req, res } = request(method, path, opts);
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-json */ }
  return { status: res.statusCode, json };
}

test('apply registers route and returns cleanup', () => {
  const { ctx, getHandler, getCleanup } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  assert.ok(getHandler());
  assert.equal(typeof getCleanup(), 'function');
  assert.equal(name, 'dsh-voice-local');
});

test('GET /health returns 200 with model/native info', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const r = await call(getHandler(), 'GET', '/dsh-voice-local/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.plugin, 'dsh-voice-local');
  assert.equal(r.json?.model?.ready, true);
});

test('GET /model/status returns 200', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const r = await call(getHandler(), 'GET', '/dsh-voice-local/v1/model/status');
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true);
  assert.equal(typeof r.json?.dir, 'string');
});

test('POST /model/download starts download via seam and returns 202', async () => {
  let called = false;
  let seenOpts = null;
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async (opts) => { called = true; seenOpts = opts; return { already: false }; },
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/model/download');
  assert.equal(r.status, 202);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.started, true);
  assert.equal(called, true);
  // 首次使用自动下载必须顺带补齐过滤器小模型（0.3.0 契约，防回归）。
  assert.equal(seenOpts?.filters, true);
});

test('POST /transcribe returns mock text', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => '你好世界',
    modelDownload: async () => ({ ok: true }),
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', {
    body: Buffer.from('RIFFfake'),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.text, '你好世界');
});

test('POST /transcribe returns model-not-ready when model missing', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => false,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', {
    body: Buffer.from('RIFFfake'),
  });
  assert.equal(r.status, 503);
  assert.equal(r.json?.error?.code, 'model-not-ready');
});

test('POST /transcribe empty body returns 400', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: Buffer.alloc(0) });
  assert.equal(r.status, 400);
  assert.equal(r.json?.error?.code, 'empty-audio');
});

test('untrusted host is rejected with 403', async () => {
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const { req, res } = request('GET', '/dsh-voice-local/v1/health', {
    headers: { host: 'evil.example.com', 'sec-fetch-site': 'cross-site' },
  });
  await getHandler()(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, 'forbidden');
});

test('cleanup unregisters route and aborts download', async () => {
  const { ctx, getHandler, getCleanup } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => ({ ok: true }),
  });
  const cleanup = getCleanup();
  assert.ok(getHandler());
  cleanup();
  assert.equal(getHandler(), null);
});

// ---- 守门编排（add-voice-noise-filtering）----
// 生产编排使用 decoder/audioFilter/recognizer/textGuard 四个 seam 注入假件，
// 覆盖拦截/放行/降级/抛错/meta 契约/配置关闭路径。

function productionApply(ctx, overrides = {}) {
  const samples = new Float32Array(16000).fill(0.5);
  const calls = { filter: [], recognize: [] };
  const config = {
    modelReady: async () => true,
    modelDownload: async () => ({ ok: true }),
    // 生产解码 seam：绕过原生 WAV 解码，直接返回固定样本（模拟"解码一次"）
    decoder: async () => ({ samples, sampleRate: 16000 }),
    audioFilter: overrides.audioFilter ?? (async (s, opts) => {
      calls.filter.push(opts);
      return { speech: true, speechMs: 1200, denoised: true, samples: s, bypass: false };
    }),
    recognizer: overrides.recognizer ?? (async (s) => {
      calls.recognize.push(s.length);
      return '你好世界';
    }),
    ...overrides.config,
  };
  // textGuard 仅在显式提供时注入；缺省走真实幻觉兜底（集成验证其响应链生效）。
  if (overrides.textGuard !== undefined) config.textGuard = overrides.textGuard;
  apply(ctx, config);
  return { calls, samples };
}

const PROD_BODY = Buffer.from('RIFFfake-audio-bytes');

test('守门放行：识别文本经幻觉兜底后返回', async () => {
  const { ctx, getHandler } = createMockCtx();
  productionApply(ctx);
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.text, '你好世界'); // 正常文本不被兜底误杀
});

test('权威拦截：非语音段返回空文本且不调用识别', async () => {
  const { ctx, getHandler } = createMockCtx();
  const { calls } = productionApply(ctx, {
    audioFilter: async (s) => ({ speech: false, speechMs: 80, denoised: true, samples: s, bypass: false }),
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.recognize, []); // 未送识别模型
  assert.equal(r.json?.text, '');
  assert.equal(r.json?.ok, true);
});

test('fail-open：守门组件缺失时主链路照常可用', async () => {
  const { ctx, getHandler } = createMockCtx();
  const { calls } = productionApply(ctx, {
    audioFilter: async (s) => ({ speech: true, speechMs: null, denoised: false, samples: s, bypass: true }),
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.equal(r.json?.text, '你好世界');
  assert.equal(calls.recognize.length, 1);
});

test('运行时降级：守门抛错按 fail-open 处理不产生 5xx', async () => {
  const { ctx, getHandler } = createMockCtx();
  const { calls } = productionApply(ctx, {
    audioFilter: async () => { throw new Error('boom in guard'); },
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.equal(r.json?.text, '你好世界');
  assert.equal(calls.recognize.length, 1);
});

test('幻觉兜底在响应链生效：识别残留被拦为空', async () => {
  const { ctx, getHandler } = createMockCtx();
  productionApply(ctx, {
    recognizer: async () => '谢谢观看。',
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.equal(r.json?.text, '');
});

test('debug meta 契约：开启附加、关闭缺席且 { ok, text } 恒定', async () => {
  const withMeta = createMockCtx();
  productionApply(withMeta.ctx, { config: { debug: true } });
  const ra = await call(withMeta.getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(ra.json?.meta?.guarded, false);
  assert.equal(ra.json?.meta?.denoised, true);
  assert.equal(ra.json?.meta?.speechMs, 1200);

  const withoutMeta = createMockCtx();
  productionApply(withoutMeta.ctx);
  const rb = await call(withoutMeta.getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(rb.json?.meta, undefined);
  assert.deepEqual({ ok: rb.json?.ok, text: rb.json?.text }, { ok: true, text: '你好世界' });
});

test('配置关闭路径：vad/denoise 关闭时透传开关且照常转写', async () => {
  const { ctx, getHandler } = createMockCtx();
  const { calls } = productionApply(ctx, {
    config: { denoise: { enabled: false }, vad: { enabled: false, minSpeechMs: 250 } },
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/transcribe', { body: PROD_BODY });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.filter, [{ vadEnabled: false, denoiseEnabled: false, minSpeechMs: 250 }]);
});

test('/health 与 /model/status 暴露过滤器状态字段', async () => {
  const { ctx, getHandler } = createMockCtx();
  productionApply(ctx);
  const h = await call(getHandler(), 'GET', '/dsh-voice-local/v1/health');
  assert.equal(h.status, 200);
  assert.ok(h.json?.filters?.vad);
  assert.ok(['ready', 'missing', 'disabled', 'error'].includes(h.json.filters.vad.state));
  assert.ok(['ready', 'missing', 'disabled', 'error'].includes(h.json.filters.denoiser.state));
  const s = await call(getHandler(), 'GET', '/dsh-voice-local/v1/model/status');
  assert.equal(s.status, 200);
  assert.ok(s.json?.filters?.vad);
  assert.equal(typeof s.json?.filters?.denoiser?.ready, 'boolean');
});
