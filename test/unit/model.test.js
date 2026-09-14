import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadModel, getDownloadState, FILTER_ASSETS, filterAssetUrls } from '../../lib/model.js';

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

// ---- 过滤器资产按发布标签分区 + 失败诊断 + 存量补齐（add-voice-hotkey-and-fix-gating D3）----

test('过滤器材产位于正确的发布标签：VAD 在 asr-models，GTCRN 在 speech-enhancement-models', () => {
  const vad = FILTER_ASSETS.find((a) => a.key === 'vad');
  const denoiser = FILTER_ASSETS.find((a) => a.key === 'denoiser');
  assert.equal(vad.releaseTag, 'asr-models');
  assert.equal(denoiser.releaseTag, 'speech-enhancement-models');
  assert.match(filterAssetUrls(vad)[0], /\/asr-models\/silero_vad\.onnx$/);
  assert.match(filterAssetUrls(denoiser)[0], /\/speech-enhancement-models\/gtcrn_simple\.onnx$/);
  // 0.3.0 的错配必须不再出现：GTCRN 不得指向 asr-models。
  assert.ok(!filterAssetUrls(denoiser).some((u) => u.includes('/asr-models/')));
});

test('过滤器材产候选 URL 构造：主源在前，镜像前缀逐条拼接', () => {
  const urls = filterAssetUrls(FILTER_ASSETS[0]);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /^https:\/\/github\.com\//);
  assert.ok(urls[1].startsWith('https://ghfast.top/https://github.com/'));
  assert.ok(urls[2].startsWith('https://gh-proxy.com/https://github.com/'));
  assert.ok(urls.every((u) => u.endsWith('/silero_vad.onnx')));
});

test('下载失败诊断：错误信息携带每条候选 URL 与各自失败原因（含镜像）', async () => {
  await withTempDir(async (dir) => {
    const voiceDir = join(dir, 'voice');
    const result = await downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      filters: true,
      voiceDir,
      retries: 0,
      fetchImpl: async (url) => {
        if (url === 'https://primary.example/model.tar.bz2') return fakeResponse('data');
        return fakeResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      },
      extractImpl: fakeExtract,
    });
    const denoiser = result.filters.denoiser;
    assert.equal(denoiser.ok, false);
    assert.equal(denoiser.attempts.length, 3, '每条候选地址都应有记录');
    for (const attempt of denoiser.attempts) {
      assert.ok(attempt.url.includes('gtcrn_simple.onnx'));
      assert.match(attempt.error, /404/);
      assert.ok(denoiser.error.includes(attempt.url), '错误信息应包含该候选 URL');
    }
    assert.match(denoiser.error, /全部候选地址均失败/);
    // 状态接口读的就是 downloadState.filters，诊断必须原样可见。
    assert.equal(getDownloadState().filters.denoiser.attempts.length, 3);
  });
});

test('0 字节过滤器资产会被重下，非空资产被跳过', async () => {
  await withTempDir(async (dir) => {
    const voiceDir = join(dir, 'voice');
    await mkdir(join(voiceDir, 'vad'), { recursive: true });
    await mkdir(join(voiceDir, 'denoiser'), { recursive: true });
    await writeFile(join(voiceDir, 'vad', 'silero_vad.onnx'), ''); // 0 字节：视为缺失
    await writeFile(join(voiceDir, 'denoiser', 'gtcrn_simple.onnx'), 'already-there');
    const calls = [];
    const result = await downloadModel({
      dir,
      modelUrl: 'https://primary.example/model.tar.bz2',
      filters: true,
      voiceDir,
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://primary.example/model.tar.bz2') return fakeResponse('data');
        if (url.endsWith('/silero_vad.onnx')) return fakeResponse('vad-bytes');
        throw new Error(`不应重下非空资产：${url}`);
      },
      extractImpl: fakeExtract,
    });
    assert.equal(result.filters.vad.ok, true, '0 字节资产应被重下');
    assert.equal(result.filters.vad.skipped, undefined);
    assert.equal(result.filters.denoiser.skipped, true, '非空资产应被跳过');
    assert.ok(calls.some((u) => u.endsWith('/silero_vad.onnx')));
    assert.ok(!calls.some((u) => u.endsWith('/gtcrn_simple.onnx')));
    assert.ok((await stat(join(voiceDir, 'vad', 'silero_vad.onnx'))).size > 0);
  });
});
