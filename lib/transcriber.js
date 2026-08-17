/**
 * dsh-voice-local SenseVoice 转写核心（sherpa-onnx-node 封装）。
 *
 * 设计要点：
 * - recognizer 单例复用（模型 ~230MB，只加载一次）
 * - 所有 decode 调用通过 promise 队列串行化（原生 recognizer handle 非线程安全）
 * - 输入统一转成 16kHz 单声道 float32 后送入 SenseVoice
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { asNativeModuleError, isNativeModuleError, nativeModuleStatus, probeResampler } from './arch.js';

const require = createRequire(import.meta.url);

export const TARGET_SAMPLE_RATE = 16000;

/** 默认模型目录：$DSH_HOME/voice/sensevoice，回退 ~/.dsh/voice/sensevoice。 */
export function defaultModelDir() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '') {
    return join(home, 'voice', 'sensevoice');
  }
  return join(homedir(), '.dsh', 'voice', 'sensevoice');
}

/**
 * 解析模型目录。优先级：显式 dir / config.modelDir > DSH_VOICE_MODEL_DIR > 默认。
 * @param {string|undefined} [dir]
 * @param {string|undefined} [configModelDir]
 */
export function modelDir(dir, configModelDir) {
  if (typeof dir === 'string' && dir !== '') return dir;
  if (typeof configModelDir === 'string' && configModelDir.trim() !== '') {
    return isAbsolute(configModelDir) ? configModelDir : join(process.cwd(), configModelDir);
  }
  if (typeof process.env.DSH_VOICE_MODEL_DIR === 'string' && process.env.DSH_VOICE_MODEL_DIR.trim() !== '') {
    return process.env.DSH_VOICE_MODEL_DIR.trim();
  }
  return defaultModelDir();
}

export function modelFiles(dir = modelDir()) {
  return {
    model: join(dir, 'model.int8.onnx'),
    tokens: join(dir, 'tokens.txt'),
  };
}

export async function modelReady(dir = modelDir()) {
  const { model, tokens } = modelFiles(dir);
  try {
    const [modelStat, tokensStat] = await Promise.all([stat(model), stat(tokens)]);
    return modelStat.size > 0 && tokensStat.size > 0;
  } catch {
    return false;
  }
}

let recognizer = null;
let recognizerDir = null;
let queue = Promise.resolve();

function loadRecognizer(dir) {
  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node/non-streaming-asr.js');
  } catch (cause) {
    if (isNativeModuleError(cause)) throw asNativeModuleError(cause);
    throw cause;
  }
  const { OfflineRecognizer } = sherpa;
  const { model, tokens } = modelFiles(dir);
  return new OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens,
      provider: 'cpu',
      numThreads: 4,
    },
    featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
  });
}

export async function ensureRecognizer(dir = modelDir()) {
  if (recognizer !== null && recognizerDir === dir) return recognizer;
  if (!(await modelReady(dir))) {
    throw new Error('SenseVoice 模型未就绪：请先下载模型（首次使用会自动下载，或调用 /model/download）');
  }
  recognizer = loadRecognizer(dir);
  recognizerDir = dir;
  return recognizer;
}

/** 释放单例（测试/热重载用）。原生 wrapper 无显式 free，置空引用交给 GC。 */
export function disposeRecognizer() {
  recognizer = null;
  recognizerDir = null;
}

/**
 * 对已归一化的 float32 音频做转写。串行化 decode，避免并发竞争。
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {string} [dir]
 * @returns {Promise<string>}
 */
export async function transcribeWave(samples, sampleRate, dir = modelDir()) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('samples must be a Float32Array');
  }
  const rec = await ensureRecognizer(dir);
  const run = () => {
    const stream = rec.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    return rec.decodeAsync(stream);
  };
  const result = await (queue = queue.then(run, run));
  return typeof result?.text === 'string' ? result.text : '';
}

/** 读取 WAV（含任意 chunk 布局），必要时重采样到 16kHz，再转写。 */
export async function transcribeWaveFile(filePath, dir = modelDir()) {
  const { readFile } = await import('node:fs/promises');
  return transcribeWavBuffer(await readFile(filePath), dir);
}

/** 读取 WAV 二进制（Uint8Array/Buffer），必要时重采样到 16kHz，再转写。 */
export async function transcribeWavBuffer(wavBuffer, dir = modelDir()) {
  let addon;
  try {
    addon = require('sherpa-onnx-node/addon.js');
  } catch (cause) {
    if (isNativeModuleError(cause)) throw asNativeModuleError(cause);
    throw cause;
  }
  if (typeof addon.readWaveFromBinary !== 'function') {
    throw new Error('sherpa-onnx native addon does not expose readWaveFromBinary');
  }
  const wave = addon.readWaveFromBinary(wavBuffer);
  if (wave.samples.length === 0) {
    return '';
  }
  let { samples, sampleRate } = wave;
  if (sampleRate !== TARGET_SAMPLE_RATE) {
    let resampler;
    try {
      const { LinearResampler } = require('sherpa-onnx-node/resampler.js');
      resampler = new LinearResampler(sampleRate, TARGET_SAMPLE_RATE);
    } catch (cause) {
      if (isNativeModuleError(cause)) throw asNativeModuleError(cause);
      cause.debug = probeResampler();
      throw cause;
    }
    samples = resampler.flush(samples);
    sampleRate = TARGET_SAMPLE_RATE;
  }
  return transcribeWave(samples, sampleRate, dir);
}

/** 汇总诊断信息（/health 用）：原生模块状态 + 模型状态。 */
export async function diagnose() {
  return {
    native: nativeModuleStatus(),
    model: { ready: await modelReady(), dir: modelDir() },
  };
}
