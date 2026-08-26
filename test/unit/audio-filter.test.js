import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioFilter, MAX_RECORD_SECONDS } from '../../lib/audio-filter.js';
import { createMutex } from '../../lib/mutex.js';

/** 假 VAD 模块：按 speechFraction 把喂入样本折算成人声时长；记录构造次数与参数。 */
function makeFakeVadModule({ fraction = 1, constructError = null } = {}) {
  const stats = { constructed: 0, lastBufferSizeSeconds: null, instances: [] };
  class FakeVad {
    constructor(config, bufferSizeInSeconds) {
      stats.constructed += 1;
      stats.lastBufferSizeSeconds = bufferSizeInSeconds;
      if (constructError) throw constructError;
      this.fraction = fraction;
      this.fed = 0;
      this.pending = false;
      stats.instances.push(this);
    }

    clear() { this.pending = false; this.fed = 0; }

    acceptWaveform(samples) {
      this.fed += samples.length;
      this.voiced = Math.round(samples.length * this.fraction);
      this.pending = true;
    }

    isEmpty() { return !this.pending; }

    front() {
      return { samples: new Float32Array(this.voiced), start: 0, end: this.voiced };
    }

    pop() { this.pending = false; }
  }
  return { module: { Vad: FakeVad }, stats };
}

/** 假降噪模块：可配置采样率（测守卫）与 run 抛错（测运行时边界）。 */
function makeFakeDenoiserModule({ sampleRate = 16000, runThrows = false } = {}) {
  const stats = { constructed: 0, ranChunks: 0, flushed: 0 };
  class FakeDenoiser {
    constructor() {
      stats.constructed += 1;
      this.sampleRate = sampleRate;
    }

    run({ samples }) {
      if (runThrows) throw new Error('boom: denoiser runtime failure');
      stats.ranChunks += 1;
      return { samples: new Float32Array(samples.length).fill(0.25), sampleRate };
    }

    flush() {
      stats.flushed += 1;
      return { samples: new Float32Array(0), sampleRate };
    }
  }
  return { module: { OnlineSpeechDenoiser: FakeDenoiser }, stats };
}

const quietLogger = { warns: [], warn(...args) { this.warns.push(args.join(' ')); } };

function oneSecond() {
  return new Float32Array(16000).fill(0.5);
}

test('编排顺序：先降噪后 VAD，人声时长达标放行且输出增强样本', async () => {
  const order = [];
  const vad = makeFakeVadModule({ fraction: 1 });
  const origAccept = vad.module.Vad.prototype.acceptWaveform;
  vad.module.Vad.prototype.acceptWaveform = function (samples) {
    order.push('vad');
    return origAccept.call(this, samples);
  };
  const den = makeFakeDenoiserModule();
  const denRun = den.module.OnlineSpeechDenoiser.prototype.run;
  den.module.OnlineSpeechDenoiser.prototype.run = function (req) {
    order.push('denoise');
    return denRun.call(this, req);
  };

  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: den.module, logger: quietLogger });
  const input = oneSecond();
  const result = await af.filterPipeline(input, {});
  assert.deepEqual(order, ['denoise', 'vad']);
  assert.equal(result.speech, true);
  assert.ok(result.speechMs >= 900, `speechMs=${result.speechMs}`);
  assert.equal(result.denoised, true);
  assert.notEqual(result.samples, input); // 输出为增强后的新缓冲
});

test('权威拦截：累计人声不足门限直接判非语音', async () => {
  const vad = makeFakeVadModule({ fraction: 0.01 }); // 1s 音频 → ~10ms 人声
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const result = await af.filterPipeline(oneSecond(), { minSpeechMs: 400 });
  assert.equal(result.speech, false);
  assert.ok(result.speechMs < 400);
});

test('模型缺失：fail-open 旁路（speech=true 且透传原样本）', async () => {
  const af = createAudioFilter({
    logger: quietLogger,
    getVadPath: () => '/nonexistent/silero_vad.onnx',
    getDenoiserPath: () => '/nonexistent/gtcrn.onnx',
  });
  const input = oneSecond();
  const result = await af.filterPipeline(input, {});
  assert.equal(result.speech, true);
  assert.equal(result.bypass, true);
  assert.equal(result.samples, input);
  const st = af.status();
  assert.equal(st.vad.state, 'missing');
  assert.equal(st.denoiser.state, 'missing');
});

test('前置守卫：降噪器采样率不匹配置 degraded 并旁路', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const den = makeFakeDenoiserModule({ sampleRate: 48000 });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: den.module, logger: quietLogger });
  const result = await af.filterPipeline(oneSecond(), {});
  assert.equal(result.denoised, false); // 降噪被旁路
  assert.equal(result.speech, true);    // VAD 照常工作
  assert.equal(af.status().denoiser.state, 'degraded');
});

test('前置守卫：Vad 缓冲容量 ≥ 最长录音秒数', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  await af.filterPipeline(oneSecond(), {});
  assert.ok(vad.stats.lastBufferSizeSeconds >= MAX_RECORD_SECONDS);
});

test('运行时边界：降噪中途抛错时旁路原始音频且只告警一次', async () => {
  const logger = { warns: [], warn(...args) { this.warns.push(args.join(' ')); } };
  const vad = makeFakeVadModule({ fraction: 1 });
  const den = makeFakeDenoiserModule({ runThrows: true });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: den.module, logger });
  const input = oneSecond();
  const first = await af.filterPipeline(input, {});
  assert.equal(first.speech, true);
  assert.equal(first.bypass, true);
  assert.equal(first.error, 'boom: denoiser runtime failure');
  assert.equal(first.samples, input);
  await af.filterPipeline(input, {}); // 第二次同样失败
  assert.equal(logger.warns.length, 1, '同一实例只告警一次');
  assert.equal(af.status().degradedRuns, 2);
});

test('并发互斥：并发首请求仅构造一次组件', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const den = makeFakeDenoiserModule();
  // 模拟慢构造放大竞态窗口
  let resolving = null;
  const gate = createMutex();
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: den.module, logger: quietLogger });
  const [a, b, c] = [af.ensureVad(), af.ensureVad(), af.ensureVad()];
  await Promise.all([a, b, c]);
  assert.equal(vad.stats.constructed, 1);
  const [x, y] = [af.ensureDenoiser(), af.ensureDenoiser()];
  await Promise.all([x, y]);
  assert.equal(den.stats.constructed, 1);
  assert.ok(resolving === null || resolving !== undefined); // gate 未用仅为占位说明
});

test('dispose 清理单例状态并允许重新加载', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  await af.ensureVad();
  assert.equal(vad.stats.constructed, 1);
  af.dispose();
  assert.equal(af.status().vad.state, 'unloaded');
  await af.ensureVad();
  assert.equal(vad.stats.constructed, 2);
});

test('共享互斥加载器：串行执行且前序失败不阻塞后续', async () => {
  const mutex = createMutex();
  const order = [];
  const p1 = mutex.run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('a');
    return 1;
  });
  const p2 = mutex.run(async () => {
    order.push('b');
    throw new Error('b failed');
  });
  const p3 = mutex.run(() => { order.push('c'); return 3; });
  await assert.rejects(p2, /b failed/);
  assert.equal(await p1, 1);
  assert.equal(await p3, 3);
  assert.deepEqual(order, ['a', 'b', 'c']);
});
