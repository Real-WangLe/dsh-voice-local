import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav,
  linearResample,
  computeRms,
  joinDraft,
  createSilenceSegmenter,
  createSerialAppender,
  concatFloat32,
  MAX_RECORD_MS,
} from '../../lib/pure.js';

test('encodeWav produces valid PCM16 mono WAV header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav(samples, 16000);
  assert.equal(wav.byteLength, 44 + samples.length * 2);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16383); // 0.5 * 32767
});

test('linearResample downsamples 48k to 16k by 1/3', () => {
  const input = new Float32Array(48000);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  const out = linearResample(input, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[0]) <= 1);
});

test('computeRms returns 0 for silence and >0 for signal', () => {
  assert.equal(computeRms(new Float32Array(1600)), 0);
  const signal = new Float32Array(1600);
  for (let i = 0; i < signal.length; i += 1) signal[i] = 0.5;
  assert.ok(computeRms(signal) > 0.4);
});

test('joinDraft appends with English/number boundary space', () => {
  assert.equal(joinDraft('', '你好'), '你好');
  assert.equal(joinDraft('你好', '世界'), '你好世界');
  assert.equal(joinDraft('hello', 'world'), 'hello world');
  assert.equal(joinDraft('abc', '123'), 'abc 123');
  assert.equal(joinDraft('中文', 'hello'), '中文hello');
});

test('silence segmenter flushes after configured silence', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    rmsThreshold: 0.01,
    silenceMs: 200,
    minSegmentMs: 50,
    onSegment: (s) => segments.push(s),
  });
  const loud = new Float32Array(1600).fill(0.5); // 100ms speech
  const silent = new Float32Array(1600).fill(0); // 100ms silence
  seg.push(loud);
  assert.equal(seg.segmentSamples, 1600);
  seg.push(silent);
  seg.push(silent); // total 200ms silence -> flush
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 4800); // 100ms speech + 200ms silence
  assert.equal(seg.segmentSamples, 0);
});

test('silence segmenter flush() emits partial segment and reset() clears', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    onSegment: (s) => segments.push(s),
  });
  seg.push(new Float32Array(1600).fill(0.5));
  seg.flush();
  assert.equal(segments.length, 1);
  assert.equal(seg.segmentSamples, 0);
  seg.push(new Float32Array(800).fill(0.5));
  seg.reset();
  assert.equal(seg.segmentSamples, 0);
  seg.flush();
  assert.equal(segments.length, 1);
});

test('concatFloat32 concatenates chunks in order', () => {
  const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test('createSerialAppender appends in order and never overwrites newer draft', async () => {
  let draft = '';
  const order = [];
  const appender = createSerialAppender({
    readDraft: () => draft,
    setDraft: (next) => { draft = next; },
    transcribe: async (samples) => {
      const id = samples[0];
      // 第二段先返回，验证仍按入队顺序写入
      if (id === 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      order.push(id);
      return `text${id}`;
    },
  });

  const p1 = appender.append(new Float32Array([1]));
  // 在第一段完成前，用户手动输入新文字
  const p2 = appender.append(new Float32Array([2]));
  await Promise.all([p1, p2]);

  assert.deepEqual(order, [1, 2]);
  assert.equal(draft, 'text1 text2');
});

test('createSerialAppender reads latest draft at append time', async () => {
  let draft = 'hello';
  let resolveTranscribe;
  const appender = createSerialAppender({
    readDraft: () => draft,
    setDraft: (next) => { draft = next; },
    transcribe: () => new Promise((resolve) => { resolveTranscribe = resolve; }),
  });
  const pending = appender.append(new Float32Array([1]));
  // 等待 transcribe 真正开始后模拟用户继续打字
  await new Promise((resolve) => setTimeout(resolve, 0));
  draft = 'hello world';
  resolveTranscribe('foo');
  await pending;
  assert.equal(draft, 'hello world foo');
});

test('MAX_RECORD_MS is 60 seconds', () => {
  assert.equal(MAX_RECORD_MS, 60_000);
});

// ---- 自适应门控（design.md D5）----

function tone(samples, level) {
  // 交替 ±level 产生确定 RMS=level 的方波，便于精确断言
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? level : -level;
  return samples;
}

test('自适应门控：恒定底噪不开门且噪声底收敛', () => {
  const fired = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 200,
    minSegmentMs: 50,
    onSegment: (s) => fired.push(s),
  });
  const noise = tone(new Float32Array(1600), 0.02);
  for (let i = 0; i < 60; i += 1) seg.push(noise); // 6s 持续底噪
  assert.equal(seg.speaking, false);
  assert.equal(seg.segmentSamples, 0);
  assert.equal(fired.length, 0);
  assert.ok(seg.noiseFloor > 0.017 && seg.noiseFloor <= 0.031, `noiseFloor=${seg.noiseFloor}`);
});

test('自适应门控：短促敲击不足最短人声时长被整段丢弃', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 200,
    minSegmentMs: 50,
    onSegment: (s) => segments.push(s),
  });
  const quiet = tone(new Float32Array(1600), 0.001);
  const knock = new Float32Array(800).fill(0.5); // 50ms 敲击
  seg.push(quiet);
  seg.push(knock);
  assert.equal(seg.speaking, true);
  seg.push(new Float32Array(4800)); // 300ms 静音 → 自动判段结束
  assert.equal(seg.speaking, false);
  assert.equal(segments.length, 0); // 人声仅 50ms < 300ms → 不上传
});

test('自适应门控：pre-roll 回带保证句首完整', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 5000, // 不自动判段，手动冲刷检查段内容
    onSegment: (s) => segments.push(s),
  });
  seg.push(tone(new Float32Array(4000), 0.001)); // 250ms 安静（恰好填满回带缓冲）
  seg.push(new Float32Array(1600).fill(0.5));    // 句首语音
  seg.flush();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 4000 + 1600);
  assert.ok(Math.abs(segments[0][0]) < 0.002, '句首应为回带的安静样本');
  assert.ok(Math.abs(segments[0][4000]) > 0.4, '回带之后是语音');
});

test('自适应门控：双门限迟滞防止临界帧截断语音', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 300,
    minSegmentMs: 100,
    onSegment: (s) => segments.push(s),
  });
  const noise = tone(new Float32Array(1600), 0.02);  // 底噪 0.02 → 开门 0.06 / 关门 0.033
  const strong = new Float32Array(1600).fill(0.08);  // 触发开门
  const mid = tone(new Float32Array(1600), 0.04);    // 介于关/开之间：应计为人声
  for (let i = 0; i < 60; i += 1) seg.push(noise);
  seg.push(strong);
  for (let i = 0; i < 20; i += 1) seg.push(mid);     // 320ms 临界帧
  assert.equal(seg.speaking, true);
  // 段内样本 = 回带（≤250ms+1 块）+ 强触发块 + 全部临界帧；未发生静音截断重开段
  assert.ok(seg.segmentSamples >= 1600 + 20 * 1600, `segmentSamples=${seg.segmentSamples}`);
  assert.ok(seg.segmentSamples <= 5600 + 1600 + 20 * 1600, `segmentSamples=${seg.segmentSamples}`);
  assert.equal(segments.length, 0);
});

test('自适应门控：强噪声底钳位后仍可开门', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 200,
    minSegmentMs: 50,
    onSegment: (s) => segments.push(s),
  });
  const loudNoise = tone(new Float32Array(1600), 0.05); // 超过 floorMax 的持续强噪
  for (let i = 0; i < 80; i += 1) seg.push(loudNoise);
  assert.equal(seg.speaking, false);
  assert.equal(seg.noiseFloor, 0.03); // 钳位生效：门槛不会被抬到语音不可达
  seg.push(new Float32Array(1600).fill(0.12)); // 真实语音仍能开门
  assert.equal(seg.speaking, true);
});

test('自适应门控与 v1 固定阈值在安静环境的等价对照', () => {
  const makeStimulus = () => ({
    speech: new Float32Array(5120).fill(0.5),   // 320ms 正常语句
    tail: new Float32Array(11200),              // 700ms 尾静音
  });
  const runLegacy = () => {
    const out = [];
    const seg = createSilenceSegmenter({
      sampleRate: 16000, rmsThreshold: 0.01, silenceMs: 700, minSegmentMs: 300,
      onSegment: (s) => out.push(s),
    });
    const { speech, tail } = makeStimulus();
    seg.push(speech); seg.push(tail);
    return { count: out.length, len: out[0]?.length ?? 0 };
  };
  const runAdaptive = () => {
    const out = [];
    const seg = createSilenceSegmenter({
      sampleRate: 16000, silenceMs: 700, minSegmentMs: 300,
      onSegment: (s) => out.push(s),
    });
    const { speech, tail } = makeStimulus();
    seg.push(speech); seg.push(tail);
    return { count: out.length, len: out[0]?.length ?? 0 };
  };
  const legacy = runLegacy();
  const adaptive = runAdaptive();
  assert.equal(adaptive.count, 1);
  assert.equal(adaptive.count, legacy.count);
  assert.ok(adaptive.len >= legacy.len, '自适应段应包含等长或更长内容（含回带）');
});

test('自适应门控：校准期内绝对强触发立即开门（点完麦克风立刻说话）', () => {
  const segments = [];
  const seg = createSilenceSegmenter({
    sampleRate: 16000,
    silenceMs: 5000,
    onSegment: (s) => segments.push(s),
  });
  seg.push(new Float32Array(1600).fill(0.5)); // 校准窗口内直接开口（RMS 远超 0.1）
  assert.equal(seg.speaking, true);
  seg.flush();
  assert.equal(segments.length, 1);
});
