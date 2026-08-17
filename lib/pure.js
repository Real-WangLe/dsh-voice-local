/**
 * dsh-voice-local 浏览器端纯函数：重采样、WAV 编码、RMS、草稿拼接、静音分段。
 * 独立成模块便于 Node 单元测试；client.js 内联同一份实现（浏览器 bundle 不依赖 ESM）。
 */

export const TARGET_SAMPLE_RATE = 16000;
export const MAX_RECORD_MS = 60_000;

export function concatFloat32(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 线性插值重采样（仅当浏览器实际采样率 ≠ 16k 时使用）。 */
export function linearResample(input, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** Float32 PCM → PCM16 mono WAV（Uint8Array）。 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  let offset = 44;
  for (let i = 0; i < n; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** 计算一段 PCM 的 RMS（0..1）。 */
export function computeRms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * 草稿追加：英文/数字边界插入空格，避免粘连。
 * @param {string} draft
 * @param {string} text
 */
export function joinDraft(draft, text) {
  const last = draft.length > 0 ? draft[draft.length - 1] : '';
  const first = text.length > 0 ? text[0] : '';
  const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
  const sep = isWord(last) && isWord(first) ? ' ' : '';
  return `${draft}${sep}${text}`;
}

/**
 * 浏览器端简单静音分段器。
 * @param {object} options
 * @param {number} [options.sampleRate] 16k
 * @param {number} [options.rmsThreshold] 默认 0.01
 * @param {number} [options.silenceMs] 默认 700ms
 * @param {number} [options.minSegmentMs] 默认 300ms
 * @param {(samples: Float32Array) => void} options.onSegment
 */
export function createSilenceSegmenter({
  sampleRate = TARGET_SAMPLE_RATE,
  rmsThreshold = 0.01,
  silenceMs = 700,
  minSegmentMs = 300,
  onSegment,
}) {
  let segment = [];
  let segmentSamples = 0;
  let silenceSamples = 0;
  let speaking = false;

  function flush() {
    if (segmentSamples === 0) return;
    const samples = concatFloat32(segment);
    segment = [];
    segmentSamples = 0;
    silenceSamples = 0;
    speaking = false;
    onSegment(samples);
  }

  return {
    push(samples) {
      const rms = computeRms(samples);
      if (rms >= rmsThreshold) {
        speaking = true;
        silenceSamples = 0;
        segment.push(samples);
        segmentSamples += samples.length;
        return;
      }
      if (!speaking) return; // 忽略前导静音
      segment.push(samples);
      segmentSamples += samples.length;
      silenceSamples += samples.length;
      const silenceMsNow = (silenceSamples / sampleRate) * 1000;
      const segmentMs = (segmentSamples / sampleRate) * 1000;
      if (silenceMsNow >= silenceMs && segmentMs >= minSegmentMs) {
        flush();
      }
    },
    flush,
    reset() {
      segment = [];
      segmentSamples = 0;
      silenceSamples = 0;
      speaking = false;
    },
    get speaking() {
      return speaking;
    },
    get segmentSamples() {
      return segmentSamples;
    },
  };
}

/**
 * 串行转写/追加器：保证多个音频段按入队顺序转写并追加，不出现乱序。
 * @param {object} deps
 * @param {() => string} deps.readDraft 同步读取最新草稿
 * @param {(text: string) => void} deps.setDraft 写入草稿（inputActions.setDraft）
 * @param {(samples: Float32Array) => Promise<string>} deps.transcribe 转写一段音频
 */
export function createSerialAppender({ readDraft, setDraft, transcribe }) {
  let queue = Promise.resolve();
  return {
    append(samples) {
      const run = queue.then(async () => {
        const text = await transcribe(samples);
        const trimmed = (text ?? '').trim();
        if (trimmed === '') return;
        const draft = typeof readDraft === 'function' ? readDraft() : '';
        const next = joinDraft(draft, trimmed);
        if (typeof setDraft === 'function') setDraft(next);
      });
      queue = run.catch(() => {});
      return run;
    },
    get idle() {
      return queue;
    },
  };
}
