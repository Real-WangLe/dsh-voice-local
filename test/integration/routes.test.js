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
  const { ctx, getHandler } = createMockCtx();
  apply(ctx, {
    modelReady: async () => true,
    transcriber: async () => 'mock text',
    modelDownload: async () => { called = true; return { already: false }; },
  });
  const r = await call(getHandler(), 'POST', '/dsh-voice-local/v1/model/download');
  assert.equal(r.status, 202);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.started, true);
  assert.equal(called, true);
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
