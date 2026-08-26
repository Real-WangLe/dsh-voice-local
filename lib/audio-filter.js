
/**
 * dsh-voice-local 音频守门管线（宿主侧）：GTCRN 降噪（可选）→ Silero VAD 人声判定。
 * 设计见 openspec/add-voice-noise-filtering/design.md D2/D3/D4/D6：
 *   - fail-open：模型缺失 / 加载失败 / 单次推理抛错一律旁路（透传原始样本），
 *     绝不阻塞听写主链路；降级计数与单次告警见 status()；
 *   - 单例经共享互斥加载器构造（并发首请求仅加载一次，评审发现 2 定案）；
 *   - 推理经 promise 队列串行化（与 transcriber.js 同模式）；
 *   - Vad 缓冲容量 ≥ MAX_RECORD 秒，覆盖最长整段 flush（评审发现 1 定案）；
 *   - denoiser 构造后断言采样率，不匹配置 degraded 旁路。
 */
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMutex } from './mutex.js';

const require = createRequire(import.meta.url);

export const TARGET_SAMPLE_RATE = 16000;
/** 与 pure.js MAX_RECORD_MS 对齐：VAD 循环缓冲容量（秒），防最长整段回绕。 */
export const MAX_RECORD_SECONDS = 60;

/** 过滤器模型的默认存放根：<DSH_HOME|~/.dsh>/voice。 */
export function voiceBaseDir(env = process.env) {
  const home = env.DSH_HOME;
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh');
  return join(base, 'voice');
}

export function vadModelPath(baseDir = voiceBaseDir()) {
  return join(baseDir, 'vad', 'silero_vad.onnx');
}

export function denoiserModelPath(baseDir = voiceBaseDir()) {
  return join(baseDir, 'denoiser', 'gtcrn_simple.onnx');
}

async function fileReady(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

const VAD_CONFIG = {
  threshold: 0.5,
  windowSize: 512,
  minSpeechDuration: 0.25,   // 秒
  minSilenceDuration: 0.5,   // 秒
  maxSpeechDuration: 20,     // 秒：超长语音内部切分，逐段弹出统计
};

/**
 * 创建守门管线实例（依赖可注入以便单元测试；生产用 getAudioFilter() 单例）。
 * @param {object} [deps]
 * @param {object} [deps.vadModule] sherpa-onnx-node/vad.js 形状的模块
 * @param {object} [deps.denoiserModule] sherpa-onnx-node/online-speech-denoiser.js 形状的模块
 * @param {object} [deps.logger]
 * @param {() => string} [deps.getVadPath]
 * @param {() => string} [deps.getDenoiserPath]
 */
export function createAudioFilter(deps = {}) {
  const logger = deps.logger ?? console;
  const getVadPath = deps.getVadPath ?? vadModelPath;
  const getDenoiserPath = deps.getDenoiserPath ?? denoiserModelPath;
  const loadVadModule = () => {
    if (deps.vadModule) return deps.vadModule;
    try { return require('sherpa-onnx-node/vad.js'); } catch { return null; }
  };
  const loadDenoiserModule = () => {
    if (deps.denoiserModule) return deps.denoiserModule;
    try { return require('sherpa-onnx-node/online-speech-denoiser.js'); } catch { return null; }
  };

  const loadMutex = createMutex();
  let queueTail = Promise.resolve();
  const state = {
    vad: { instance: null, state: 'unloaded' },
    denoiser: { instance: null, state: 'unloaded' },
    degradedRuns: 0,
    runtimeWarned: false,
  };

  async function ensureVad() {
    if (state.vad.instance) return state.vad.instance;
    // error/degraded 是终态结论；missing 允许重试——模型文件可能在运行时被
    // /model/download 补齐（下载成功后路由也会 dispose 重置），stat 很廉价。
    if (state.vad.state === 'error' || state.vad.state === 'degraded') return null;
    if (state.vad.state === 'missing' && !(await fileReady(getVadPath()))) return null;
    await loadMutex.run(async () => {
      if (state.vad.instance || state.vad.state !== 'unloaded') return;
      const mod = loadVadModule();
      if (!mod || typeof mod.Vad !== 'function') {
        state.vad.state = 'error';
        return;
      }
      const model = getVadPath();
      // 注入模块（测试）跳过文件存在性检查，保证用例不依赖宿主真实模型。
      if (!deps.vadModule && !(await fileReady(model))) {
        state.vad.state = 'missing';
        return;
      }
      try {
        state.vad.instance = new mod.Vad(
          { sileroVad: { model, ...VAD_CONFIG }, sampleRate: TARGET_SAMPLE_RATE, numThreads: 4 },
          MAX_RECORD_SECONDS,
        );
        state.vad.state = 'ready';
      } catch (cause) {
        logger.warn?.('[dsh-voice-local] Silero VAD 加载失败，已旁路:', cause?.message ?? cause);
        state.vad.state = 'error';
      }
    });
    return state.vad.instance;
  }

  async function ensureDenoiser() {
    if (state.denoiser.instance) return state.denoiser.instance;
    // 与 ensureVad 同语义：missing 可重试，error/degraded 终态。
    if (state.denoiser.state === 'error' || state.denoiser.state === 'degraded') return null;
    if (state.denoiser.state === 'missing' && !(await fileReady(getDenoiserPath()))) return null;
    await loadMutex.run(async () => {
      if (state.denoiser.instance || state.denoiser.state !== 'unloaded') return;
      const mod = loadDenoiserModule();
      if (!mod || typeof mod.OnlineSpeechDenoiser !== 'function') {
        state.denoiser.state = 'error';
        return;
      }
      const model = getDenoiserPath();
      if (!deps.denoiserModule && !(await fileReady(model))) {
        state.denoiser.state = 'missing';
        return;
      }
      try {
        const inst = new mod.OnlineSpeechDenoiser({
          model: { gtcrn: { model } },
          numThreads: 4,
        });
        // 评审发现 1 定案：原生采样率必须与目标一致，否则置 degraded 旁路而非硬喂。
        if (inst.sampleRate !== TARGET_SAMPLE_RATE) {
          logger.warn?.(`[dsh-voice-local] GTCRN 降噪器采样率 ${inst.sampleRate} ≠ ${TARGET_SAMPLE_RATE}，已旁路`);
          state.denoiser.state = 'degraded';
          return;
        }
        state.denoiser.instance = inst;
        state.denoiser.state = 'ready';
      } catch (cause) {
        logger.warn?.('[dsh-voice-local] GTCRN 降噪器加载失败，已旁路:', cause?.message ?? cause);
        state.denoiser.state = 'error';
      }
    });
    return state.denoiser.instance;
  }

  function runDenoise(inst, samples) {
    const chunkSize = TARGET_SAMPLE_RATE * 2; // 2s 分块，限制单次峰值内存
    const parts = [];
    for (let offset = 0; offset < samples.length; offset += chunkSize) {
      const chunk = samples.subarray(offset, Math.min(offset + chunkSize, samples.length));
      const out = inst.run({ samples: chunk, sampleRate: TARGET_SAMPLE_RATE });
      if (out?.samples instanceof Float32Array && out.samples.length > 0) parts.push(out.samples);
    }
    const tailOut = inst.flush();
    if (tailOut?.samples instanceof Float32Array && tailOut.samples.length > 0) parts.push(tailOut.samples);
    const total = parts.reduce((n, p) => n + p.length, 0);
    if (total === 0) return samples; // 无有效输出：退回原样本
    const merged = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  async function corePipeline(samples, opts) {
    const vadEnabled = opts.vadEnabled !== false;
    const denoiseEnabled = opts.denoiseEnabled !== false;
    const minSpeechMs = Number.isFinite(opts.minSpeechMs) ? opts.minSpeechMs : 400;

    let out = samples;
    let denoised = false;
    if (denoiseEnabled) {
      const den = await ensureDenoiser();
      if (den) {
        out = runDenoise(den, out);
        denoised = out !== samples;
      }
    }

    let speechMs = null;
    let vadJudged = false;
    if (vadEnabled) {
      const vad = await ensureVad();
      if (vad) {
        vadJudged = true;
        vad.clear();
        vad.acceptWaveform(out);
        let voicedSamples = 0;
        while (!vad.isEmpty()) {
          const seg = vad.front();
          voicedSamples += seg?.samples?.length ?? 0;
          vad.pop();
        }
        speechMs = Math.round((voicedSamples / TARGET_SAMPLE_RATE) * 1000);
        if (speechMs < minSpeechMs) {
          // 权威拦截：非语音段直接短路，不送识别（spec「环境噪声人声守门」）。
          return { speech: false, speechMs, denoised, samples: out, bypass: false };
        }
      }
    }

    // bypass 语义：配置要求守门但人声判定未能执行（组件缺失/降级）——
    // 放行属 fail-open，调用方（meta/health）可据此区分"真通过"与"未守门"。
    return { speech: true, speechMs, denoised, samples: out, bypass: vadEnabled && !vadJudged };
  }

  /**
   * 守门主入口。全包 try/catch（design D6 运行时边界）：任何推理异常都
   * 以 fail-open 收场——透传原始样本继续识别，绝不放大为请求失败。
   */
  async function filterPipeline(samples, opts = {}) {
    if (!(samples instanceof Float32Array) || samples.length === 0) {
      return { speech: true, bypass: true, reason: 'empty-input', speechMs: null, denoised: false, samples };
    }
    const run = queueTail.then(async () => {
      try {
        return await corePipeline(samples, opts);
      } catch (cause) {
        state.degradedRuns += 1;
        if (!state.runtimeWarned) {
          state.runtimeWarned = true;
          logger.warn?.('[dsh-voice-local] 守门推理异常，本段旁路原始音频:', cause?.message ?? cause);
        }
        return {
          speech: true,
          speechMs: null,
          denoised: false,
          samples,
          bypass: true,
          error: String(cause?.message ?? cause),
        };
      }
    });
    queueTail = run.catch(() => {});
    return run;
  }

  function status() {
    return {
      vad: { state: state.vad.state },
      denoiser: { state: state.denoiser.state },
      degradedRuns: state.degradedRuns,
    };
  }

  function dispose() {
    state.vad.instance = null;
    state.vad.state = 'unloaded';
    state.denoiser.instance = null;
    state.denoiser.state = 'unloaded';
    state.degradedRuns = 0;
    state.runtimeWarned = false;
  }

  return { filterPipeline, status, dispose, ensureVad, ensureDenoiser };
}

// ---- 进程级单例（热重载/卸载时 dispose） ----
let singleton = null;

export function getAudioFilter() {
  if (singleton === null) singleton = createAudioFilter();
  return singleton;
}

export async function filterPipeline(samples, opts) {
  return getAudioFilter().filterPipeline(samples, opts);
}

/** 运行时状态（含 degraded 计数），供 /health 组装。 */
export function audioFilterRuntimeStatus() {
  return getAudioFilter().status();
}

/** 过滤器模型文件就绪情况（与运行时状态解耦，惰性加载前也可查询）。 */
export async function audioFilterModelStatus() {
  const [vad, denoiser] = await Promise.all([
    fileReady(vadModelPath()),
    fileReady(denoiserModelPath()),
  ]);
  return { vad, denoiser };
}

export function disposeAudioFilter() {
  if (singleton !== null) {
    singleton.dispose();
    singleton = null;
  }
}
