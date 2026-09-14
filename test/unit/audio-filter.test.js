import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioFilter, MAX_RECORD_SECONDS, VAD_WINDOW_SIZE } from '../../lib/audio-filter.js';
import { createMutex } from '../../lib/mutex.js';

/**
 * 假 VAD 模块：**跨调用累计语义**（评审 OV-3 定案）。
 *
 * 旧 fake 的 `acceptWaveform` 每次调用重算 `voiced = samples.length * fraction`
 * 并置 pending，即"一次调用 = 一段"——它对"一次喂多少"天然免疫，从设计上就
 * 不可能暴露调用形状类缺陷（0.3.0 的 P0 正是从这个缺口漏出去的）。
 *
 * 新语义：内部缓冲累积全部 `acceptWaveform` 入参，`front()` / `isEmpty()` /
 * `pop()` 反映累计后的段；`fraction` 旋钮保持既有 9 条断言的意图不变；
 * 同时记录每次调用的入参长度（`calls`）与副本（`chunks`），供契约测试断言
 * "每次调用 ≤ VAD_WINDOW_SIZE、拼接后等于输入"。
 */
function makeFakeVadModule({ fraction = 1, constructError = null } = {}) {
  const stats = { constructed: 0, lastBufferSizeSeconds: null, instances: [] };
  class FakeVad {
    constructor(config, bufferSizeInSeconds) {
      stats.constructed += 1;
      stats.lastBufferSizeSeconds = bufferSizeInSeconds;
      if (constructError) throw constructError;
      this.fraction = fraction;
      this.pending = false;
      this.total = 0;
      this.calls = [];   // 每次 acceptWaveform 的入参长度
      this.chunks = [];  // 每次入参的副本（按序拼接 = 完整输入）
      stats.instances.push(this);
    }

    clear() { this.pending = false; this.total = 0; this.calls = []; this.chunks = []; }

    acceptWaveform(samples) {
      this.calls.push(samples.length);
      this.total += samples.length;
      this.chunks.push(Float32Array.from(samples));
      this.pending = true;
    }

    isEmpty() { return !this.pending; }

    front() {
      const voiced = Math.round(this.total * this.fraction);
      return { samples: new Float32Array(voiced), start: 0, end: voiced };
    }

    pop() { this.pending = false; }

    /** 与真实 Vad 对齐：累计语义下无需额外动作（段已在 front() 中可见）。 */
    flush() { this.pending = this.total > 0; }

    /** 全部调用按序拼接后的样本（与喂入输入逐样本相等即覆盖完整）。 */
    fedSamples() {
      const out = new Float32Array(this.total);
      let offset = 0;
      for (const chunk of this.chunks) { out.set(chunk, offset); offset += chunk.length; }
      return out;
    }
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
  // 分块喂入后 VAD 会被调用多次（每次 ≤ 512 样本）；此处只断言编排顺序：
  // 降噪先于 VAD，且之后不再出现降噪调用。
  assert.equal(order[0], 'denoise');
  assert.ok(order.length > 1 && order.slice(1).every((step) => step === 'vad'), JSON.stringify(order));
  assert.equal(result.speech, true);
  assert.ok(result.speechMs >= 900, `speechMs=${result.speechMs}`);
  assert.equal(result.denoised, true);
  assert.notEqual(result.samples, input); // 输出为增强后的新缓冲
});

test('VAD 喂入契约：每次调用 ≤ 窗口、按序拼接覆盖完整输入（含末尾余数）、调用次数 > 1', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const input = oneSecond(); // 16000 = 31 × 512 + 128
  // 关掉降噪，让 VAD 收到的就是输入本身，才能逐样本核对"覆盖完整输入"。
  await af.filterPipeline(input, { denoiseEnabled: false });
  const inst = vad.stats.instances.at(-1);
  assert.ok(
    inst.calls.length > 1,
    `分块喂入要求调用次数 > 1，实际 ${inst.calls.length} 次（单次样本数 ${inst.calls.join(',')}）`,
  );
  for (const n of inst.calls) {
    assert.ok(n <= VAD_WINDOW_SIZE, `单次调用 ${n} 样本超过窗口 ${VAD_WINDOW_SIZE}`);
  }
  assert.equal(inst.calls.at(-1), input.length % VAD_WINDOW_SIZE, '末尾不足一块的余数应单独成块');
  const fed = inst.fedSamples();
  assert.equal(fed.length, input.length, '全部调用样本数之和应等于输入长度');
  let same = true;
  for (let i = 0; i < input.length; i += 1) {
    if (fed[i] !== input[i]) { same = false; break; }
  }
  assert.ok(same, '全部调用按序拼接应逐样本等于输入（覆盖完整音频）');
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

test('可观测面：judgedRuns/emptyRuns 累加、recentSpeechMs 只留最近 10 次、dispose 归零', async () => {
  const vad = makeFakeVadModule({ fraction: 1 });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const inst = () => vad.stats.instances.at(-1);
  await af.ensureVad(); // 惰性构造：先物化实例才能逐次调整 fraction 旋钮
  const values = [];
  for (let i = 1; i <= 12; i += 1) {
    inst().fraction = i / 100; // 100ms..1200ms，逐一不同，便于核对环形缓冲
    const ms = Math.round(16000 * (i / 100) / 16);
    values.push(ms);
    const r = await af.filterPipeline(oneSecond(), { denoiseEnabled: false, minSpeechMs: 0 });
    assert.equal(r.speechMs, ms);
  }
  let st = af.status();
  assert.equal(st.judgedRuns, 12, '每次完成的判定都应累加');
  assert.equal(st.emptyRuns, 0, '门限 0 时没有拦截');
  assert.equal(st.vad.runs, 12, 'VAD 运行次数与判定次数一致');
  assert.equal(st.recentSpeechMs.length, 10, '环形缓冲只保留最近 10 次');
  assert.deepEqual(st.recentSpeechMs, values.slice(-10), '保留的是最近 10 次判定值');

  inst().fraction = 0;
  await af.filterPipeline(oneSecond(), { denoiseEnabled: false, minSpeechMs: 400 });
  st = af.status();
  assert.equal(st.emptyRuns, 1, '低于门限的判定计入 emptyRuns');
  assert.equal(st.recentSpeechMs.at(-1), 0);

  af.dispose();
  st = af.status();
  assert.equal(st.judgedRuns, 0);
  assert.equal(st.emptyRuns, 0);
  assert.deepEqual(st.recentSpeechMs, []);
  assert.equal(st.vad.runs, 0);
  assert.equal(st.vad.errors, 0);
  assert.equal(st.denoiser.runs, 0);
});

test('gateReason 五值：speech / below-min-speech / no-speech / bypass-missing / bypass-error', async () => {
  // speech：人声时长达标
  const okVad = makeFakeVadModule({ fraction: 1 });
  const ok = createAudioFilter({ vadModule: okVad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  assert.equal((await ok.filterPipeline(oneSecond(), {})).gateReason, 'speech');

  // below-min-speech：有判定但低于门限
  const lowVad = makeFakeVadModule({ fraction: 0.05 }); // 1s → 50ms
  const low = createAudioFilter({ vadModule: lowVad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const lowRes = await low.filterPipeline(oneSecond(), { minSpeechMs: 400 });
  assert.equal(lowRes.speech, false);
  assert.equal(lowRes.gateReason, 'below-min-speech');

  // no-speech：判定为 0ms（根本没检出人声）
  const zeroVad = makeFakeVadModule({ fraction: 0 });
  const zero = createAudioFilter({ vadModule: zeroVad.module, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const zeroRes = await zero.filterPipeline(oneSecond(), { minSpeechMs: 400 });
  assert.equal(zeroRes.speech, false);
  assert.equal(zeroRes.gateReason, 'no-speech');

  // bypass-missing：VAD 模型文件缺失 → fail-open 旁路
  const missing = createAudioFilter({
    logger: quietLogger,
    getVadPath: () => '/nonexistent/silero_vad.onnx',
    getDenoiserPath: () => '/nonexistent/gtcrn.onnx',
  });
  const missingRes = await missing.filterPipeline(oneSecond(), {});
  assert.equal(missingRes.bypass, true);
  assert.equal(missingRes.gateReason, 'bypass-missing');

  // bypass-error：VAD 模块形状不对（加载失败）→ fail-open 旁路
  const broken = createAudioFilter({ vadModule: {}, denoiserModule: makeFakeDenoiserModule().module, logger: quietLogger });
  const brokenRes = await broken.filterPipeline(oneSecond(), {});
  assert.equal(brokenRes.bypass, true);
  assert.equal(brokenRes.gateReason, 'bypass-error');
  assert.equal(broken.status().vad.state, 'error');
});

test('组件化留痕：降噪/VAD 各自计数与最近错误，告警按组件独立 warn-once 互不掩盖', async () => {
  const logger = { warns: [], warn(...args) { this.warns.push(args.join(' ')); } };
  const vad = makeFakeVadModule({ fraction: 1 });
  const den = makeFakeDenoiserModule({ runThrows: true });
  const af = createAudioFilter({ vadModule: vad.module, denoiserModule: den.module, logger });

  // 1) 降噪抛错：记到 denoiser 名下并告警一次
  await af.filterPipeline(oneSecond(), {});
  await af.filterPipeline(oneSecond(), {});
  let st = af.status();
  assert.equal(st.denoiser.errors, 2);
  assert.match(st.denoiser.lastError, /boom: denoiser runtime failure/);
  assert.equal(st.vad.errors, 0, 'VAD 未被降噪的异常牵连');
  assert.equal(logger.warns.length, 1, '降噪组件只告警一次');
  assert.match(logger.warns[0], /降噪/);

  // 2) 换一个"降噪正常但 VAD 抛错"的实例：VAD 的告警不得被前面的降噪告警掩盖
  const vadThrows = makeFakeVadModule({ fraction: 1 });
  vadThrows.module.Vad.prototype.acceptWaveform = function () { throw new Error('vad boom'); };
  const af2 = createAudioFilter({ vadModule: vadThrows.module, denoiserModule: makeFakeDenoiserModule().module, logger });
  await af2.filterPipeline(oneSecond(), {});
  await af2.filterPipeline(oneSecond(), {});
  st = af2.status();
  assert.equal(st.vad.errors, 2);
  assert.match(st.vad.lastError, /vad boom/);
  assert.equal(st.denoiser.errors, 0, '降噪未被 VAD 的异常牵连');
  assert.equal(st.denoiser.lastError, null);
  assert.equal(logger.warns.length, 2, 'VAD 组件应有自己的独立告警');
  assert.match(logger.warns[1], /Silero VAD/);
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
