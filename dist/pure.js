/**
 * dsh-voice-local 浏览器端纯函数：重采样、WAV 编码、RMS、草稿拼接、静音分段。
 * 独立成模块便于 Node 单元测试；浏览器 bundle 由 scripts/build.mjs 以 fragment
 * 拼接自动携带本文件（保持纯函数，勿引入 Node 专属 API）。
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
 * 浏览器端自适应静音分段器（design.md D5）。
 *
 * 相比 v1 固定 RMS 阈值的升级点：
 *   - 噪声底 EMA 跟踪：仅关门态且 RMS 明显低于开门阈值时更新，钳位
 *     [floorMin, floorMax]，防止持续强噪把门槛抬到语音不可达；
 *   - 双门限迟滞：open = max(noiseFloor*kOpen, absOpenMin)，close = open*closeRatio；
 *   - pre-roll 环形缓冲：触发时回带此前至多 preRollMs 毫秒音频，句首不吞字；
 *   - hangover：沿用"尾静音累积满 silenceMs 才判段结束"的拖尾语义；
 *   - 最短人声门：自动分段结束时累计人声 < minSpeechMs 的整段丢弃，
 *     不上传转写；手动 flush() 不受此限（对齐停止语义矩阵的"冲刷"承诺）。
 *
 * 兼容：显式传入 rmsThreshold 时进入 v1 等价固定阈值模式（无自适应、无回带、
 * 无最短人声门），既有调用方与测试语义完全不变。
 * @param {object} options
 * @param {number} [options.sampleRate] 16k
 * @param {number} [options.rmsThreshold] 显式传入 = v1 固定阈值模式
 * @param {number} [options.silenceMs] 默认 700ms
 * @param {number} [options.minSegmentMs] 默认 300ms
 * @param {number} [options.minSpeechMs] 自适应模式：段内累计人声下限，默认 300ms
 * @param {number} [options.preRollMs] 触发前回带时长，默认 250ms
 * @param {number} [options.floorMin] 噪声底下钳位，默认 0.002
 * @param {number} [options.floorMax] 噪声底上钳位，默认 0.03
 * @param {number} [options.kOpen] 开门阈值倍率，默认 3
 * @param {number} [options.closeRatio] 关门/开门比，默认 0.55
 * @param {number} [options.absOpenMin] 开门绝对下限（安静房间退化为 v1 行为），默认 0.01
 * @param {number} [options.calibrateMs] 启动校准窗口：只建底噪不触发，防环境噪声冷启动误判，默认 300ms
 * @param {number} [options.hardTriggerMin] 校准期内的绝对强触发下限（明显即语音），默认 0.1
 * @param {number} [options.emaAlpha] 噪声底平滑系数，默认 0.06
 * @param {(samples: Float32Array) => void} options.onSegment
 */
export function createSilenceSegmenter({
  sampleRate = TARGET_SAMPLE_RATE,
  rmsThreshold,
  silenceMs = 700,
  minSegmentMs = 300,
  minSpeechMs = 300,
  preRollMs = 250,
  floorMin = 0.002,
  floorMax = 0.03,
  kOpen = 3,
  closeRatio = 0.55,
  absOpenMin = 0.01,
  calibrateMs = 300,
  hardTriggerMin = 0.1,
  emaAlpha = 0.06,
  onSegment,
}) {
  const legacy = typeof rmsThreshold === 'number';
  const preRollSamples = Math.round((preRollMs / 1000) * sampleRate);
  const calibrateSamples = Math.round((calibrateMs / 1000) * sampleRate);
  const clampFloor = (v) => Math.min(Math.max(v, floorMin), floorMax);

  let segment = [];        // 开门后的片段累积
  let segmentSamples = 0;
  let speechSamples = 0;   // 人声态（RMS ≥ 关门阈值）累计样本数
  let silenceSamples = 0;
  let speaking = false;
  let noiseFloor = floorMin;
  let preRing = [];        // 关门态最近音频（pre-roll 回带源）
  let preRingSamples = 0;
  let closedSamples = 0;   // 本次开门周期内关门态样本数（启动校准计时器）

  function resetAll() {
    segment = [];
    segmentSamples = 0;
    speechSamples = 0;
    silenceSamples = 0;
    speaking = false;
    preRing = [];
    preRingSamples = 0;
    if (!legacy) closedSamples = 0;
  }

  /** 是否仍在启动校准窗口内（仅自适应模式）。 */
  function calibrating() {
    return !legacy && closedSamples < calibrateSamples;
  }

  /** includeGate=true 时应用最短人声门（仅自动分段）；手动冲刷始终放行。 */
  function emit(includeGate) {
    if (segmentSamples === 0) return;
    const samples = concatFloat32(segment);
    const keep = !includeGate || (speechSamples / sampleRate) * 1000 >= minSpeechMs;
    resetAll();
    if (keep) onSegment(samples);
  }

  return {
    push(samples) {
      const rms = computeRms(samples);
      const openThreshold = legacy ? rmsThreshold : Math.max(clampFloor(noiseFloor) * kOpen, absOpenMin);

      if (!speaking) {
        closedSamples += samples.length;
        // 启动校准窗口：只允许快速建立噪声底，不触发开门（防冷启动把环境
        // 噪声当语音；窗口内音频进入 pre-ring，触发后随回带保留句首）。
        const calibratingNow = calibrating();
        // 校准期内仅放行"明显是语音"的绝对强触发（如用户点完麦克风立刻开口）。
        if ((!calibratingNow && rms >= openThreshold) || (!legacy && rms >= hardTriggerMin)) {
          speaking = true;
          segment = legacy ? [samples] : [...preRing, samples];
          segmentSamples = (legacy ? 0 : preRingSamples) + samples.length;
          speechSamples = samples.length;
          silenceSamples = 0;
          preRing = [];
          preRingSamples = 0;
          return;
        }
        if (!legacy) {
          // 校准期用大步长快速收敛到真实环境底；之后凡低于开门阈值的帧都
          // 慢速跟踪（触发帧永不参与更新，语音起始不会污染噪声底估计）。
          if (calibratingNow) {
            noiseFloor = clampFloor(noiseFloor * 0.8 + rms * 0.2);
          } else if (rms < openThreshold) {
            noiseFloor = clampFloor(noiseFloor * (1 - emaAlpha) + rms * emaAlpha);
          }
          preRing.push(samples);
          preRingSamples += samples.length;
          while (preRing.length > 0 && preRingSamples - preRing[0].length >= preRollSamples) {
            preRingSamples -= preRing[0].length;
            preRing.shift();
          }
        }
        return;
      }

      const closeThreshold = legacy ? rmsThreshold : openThreshold * closeRatio;
      segment.push(samples);
      segmentSamples += samples.length;
      if (rms >= closeThreshold) {
        speechSamples += samples.length;
        silenceSamples = 0;
      } else {
        silenceSamples += samples.length;
      }
      const silenceMsNow = (silenceSamples / sampleRate) * 1000;
      const segmentMs = (segmentSamples / sampleRate) * 1000;
      if (silenceMsNow >= silenceMs && segmentMs >= minSegmentMs) {
        emit(!legacy); // v1 固定阈值模式不设最短人声门，语义完全等价旧版
      }
    },
    flush() {
      emit(false);
    },
    reset() {
      resetAll();
    },
    get speaking() {
      return speaking;
    },
    get segmentSamples() {
      return segmentSamples;
    },
    /** 当前噪声底估计（v1 固定阈值模式为 null），诊断用。 */
    get noiseFloor() {
      return legacy ? null : clampFloor(noiseFloor);
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

/**
 * 光标处插入（design.md D8）：把 insert 插到 text 的 caret 位置，
 * 在新文本与两侧英文/数字边界处补空格防粘连。
 * @returns {{ value: string, caret: number }} 拼接结果与新光标位置（插入文本末尾）
 */
export function composeInsertion({ text, caret, insert }) {
  const pos = Math.max(0, Math.min(typeof caret === 'number' ? caret : text.length, text.length));
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
  const lastBefore = before.length > 0 ? before[before.length - 1] : '';
  const firstInsert = insert.length > 0 ? insert[0] : '';
  const lastInsert = insert.length > 0 ? insert[insert.length - 1] : '';
  const firstAfter = after.length > 0 ? after[0] : '';
  const sepBefore = isWord(lastBefore) && isWord(firstInsert) ? ' ' : '';
  const sepAfter = isWord(lastInsert) && isWord(firstAfter) ? ' ' : '';
  return {
    value: `${before}${sepBefore}${insert}${sepAfter}${after}`,
    caret: pos + sepBefore.length + insert.length,
  };
}
