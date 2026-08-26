import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadModel, getDownloadState } from '../../lib/model.js';

function fakeResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return {
    ok,
    status,
    statusText,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length' ? String(bytes.length) : null;
      },
    },
    body: {
      getReader() {
        return {
          read() {
            if (offset >= bytes.length) return Promise.resolve({ done: true });
            const value = bytes.subarray(offset, offset + 2);
            offset += 2;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    },
  };
}

async function fakeExtract(archive, extractDir) {
  await mkdir(extractDir, { recursive: true });
  await writeFile(join(extractDir, 'model.int8.onnx'), 'model-bytes');
  await writeFile(join(extractDir, 'tokens.txt'), 'tokens');
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-local-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('downloadModel starts in downloading state and finishes ready', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      mirrorUrl: 'https://mirror.example/model.tar.bz2',
      modelUrl: 'https://primary.example/model.tar.bz2',
      fetchImpl: async (url) => { calls.push(url); return fakeResponse('data'); },
      extractImpl: fakeExtract,
    });
    assert.equal(getDownloadState().status, 'downloading');
    const result = await promise;
    assert.equal(result.already, false);
    assert.equal(getDownloadState().status, 'ready');
    assert.deepEqual(calls, ['https://mirror.example/model.tar.bz2']);
  });
});

test('downloadModel falls back from mirror to primary URL', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      mirrorUrl: 'https://mirror.example/model.tar.bz2',
      modelUrl: 'https://primary.example/model.tar.bz2',
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://primary.example/model.tar.bz2') {
          return fakeResponse('data');
        }
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      },
      extractImpl: fakeExtract,
    });
    const result = await promise;
    assert.equal(result.already, false);
    assert.equal(calls[0], 'https://mirror.example/model.tar.bz2');
    assert.equal(calls.at(-1), 'https://primary.example/model.tar.bz2');
  });
});

test('downloadModel tries mirrors array in order before primary', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      mirrorUrl: 'https://single-mirror.example/model.tar.bz2',
      mirrors: ['https://mirror-a.example/model.tar.bz2', 'https://mirror-b.example/model.tar.bz2'],
      modelUrl: 'https://primary.example/model.tar.bz2',
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://single-mirror.example/model.tar.bz2' || url === 'https://mirror-a.example/model.tar.bz2') {
          return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
        }
        return fakeResponse('data');
      },
      extractImpl: fakeExtract,
    });
    const result = await promise;
    assert.equal(result.already, false);
    assert.deepEqual(calls, [
      'https://single-mirror.example/model.tar.bz2',
      'https://mirror-a.example/model.tar.bz2',
      'https://mirror-b.example/model.tar.bz2',
    ]);
  });
});

test('downloadModel supports Hugging Face direct file mirrors', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      mirrorUrl: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/model.int8.onnx')) return fakeResponse('model-bytes');
        if (url.endsWith('/tokens.txt')) return fakeResponse('tokens');
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      },
      extractImpl: async () => { throw new Error('should not extract'); },
    });
    const result = await promise;
    assert.equal(result.already, false);
    assert.equal(getDownloadState().status, 'ready');
    assert.ok(calls.some((u) => u.includes('/resolve/main/model.int8.onnx')));
    assert.ok(calls.some((u) => u.includes('/resolve/main/tokens.txt')));
  });
});

test('downloadModel rejects on SHA256 mismatch and records error state', async () => {
  await withTempDir(async (dir) => {
    const body = 'data';
    const wrongSha = '0'.repeat(64);
    const promise = downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      sha256: wrongSha,
      fetchImpl: async () => fakeResponse(body),
      extractImpl: fakeExtract,
    });
    await assert.rejects(promise, /SHA256 校验失败/);
    assert.equal(getDownloadState().status, 'error');
    assert.match(getDownloadState().error, /SHA256/);
  });
});

test('downloadModel reuses existing model and does not download', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.int8.onnx'), 'model');
    await writeFile(join(dir, 'tokens.txt'), 'tokens');
    let downloaded = false;
    const result = await downloadModel({
      dir,
      fetchImpl: async () => { downloaded = true; return fakeResponse('data'); },
      extractImpl: fakeExtract,
    });
    assert.equal(result.already, true);
    assert.equal(downloaded, false);
  });
});

test('downloadModel rejects on direct file model SHA256 mismatch', async () => {
  await withTempDir(async (dir) => {
    const promise = downloadModel({
      dir,
      mirrorUrl: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      retries: 0,
      modelSha256: '0'.repeat(64),
      fetchImpl: async (url) => {
        if (url.endsWith('/model.int8.onnx')) return fakeResponse('model-bytes');
        if (url.endsWith('/tokens.txt')) return fakeResponse('tokens');
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      },
      extractImpl: async () => { throw new Error('should not extract'); },
    });
    await assert.rejects(promise, /SHA256 校验失败/);
    assert.equal(getDownloadState().status, 'error');
  });
});

test('user modelUrl is tried before built-in mirrors', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://primary.example/model.tar.bz2') return fakeResponse('data');
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      },
      extractImpl: fakeExtract,
    });
    await promise;
    assert.equal(calls[0], 'https://primary.example/model.tar.bz2');
  });
});

// ---- 过滤器资产下载（add-voice-noise-filtering）----

test('filters:true 顺序下载三资产且小模型失败被隔离', async () => {
  await withTempDir(async (dir) => {
    const voiceDir = join(dir, 'voice');
    const calls = [];
    const promise = downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      filters: true,
      voiceDir,
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://primary.example/model.tar.bz2') return fakeResponse('data');
        if (url.endsWith('/silero_vad.onnx')) return fakeResponse('vad-bytes');
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' }); // gtcrn 全源失败
      },
      extractImpl: fakeExtract,
    });
    const result = await promise;
    assert.equal(calls[0], 'https://primary.example/model.tar.bz2'); // 主模型先于过滤器
    assert.ok(calls.some((u) => u.endsWith('/silero_vad.onnx')));
    assert.ok(calls.some((u) => u.endsWith('/gtcrn_simple.onnx')));
    assert.equal(getDownloadState().status, 'ready'); // 小模型失败不置整体 error
    assert.equal(result.filters.vad.ok, true);
    assert.equal(result.filters.denoiser.ok, false);
    const vadStat = await stat(join(voiceDir, 'vad', 'silero_vad.onnx'));
    assert.ok(vadStat.size > 0);
  });
});

test('filters:true 且 SenseVoice 已存在时仅补齐过滤器（老用户升级路径）', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.int8.onnx'), 'model');
    await writeFile(join(dir, 'tokens.txt'), 'tokens');
    const voiceDir = join(dir, 'voice');
    const calls = [];
    const result = await downloadModel({
      dir,
      filters: true,
      voiceDir,
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/silero_vad.onnx')) return fakeResponse('vad-bytes');
        if (url.endsWith('/gtcrn_simple.onnx')) return fakeResponse('gtcrn-bytes');
        throw new Error(`不应下载主模型：${url}`);
      },
      extractImpl: async () => { throw new Error('should not extract'); },
    });
    assert.equal(result.already, true);
    assert.ok(calls.length > 0 && calls.every((u) => u.endsWith('.onnx')), JSON.stringify(calls));
    assert.equal(result.filters.vad.ok, true);
    assert.equal(result.filters.denoiser.ok, true);
  });
});

test('filters 未开启时不触碰过滤器下载（既有调用方零影响）', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const promise = downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      fetchImpl: async (url) => { calls.push(url); return fakeResponse('data'); },
      extractImpl: fakeExtract,
    });
    const result = await promise;
    assert.equal(result.filters ?? null, null);
    assert.ok(calls.every((u) => !u.includes('.onnx')));
  });
});
