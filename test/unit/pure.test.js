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
