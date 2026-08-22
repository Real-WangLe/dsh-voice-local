/**
 * dsh-voice-local 浏览器端：共享听写控制器。
 *
 * 一个 controller 实例持有至多一个录音会话；主输入框与提问卡片两个入口以
 * TargetAdapter 身份接入，共享同一串行转写队列。职责：
 *   - 录音会话生命周期（getUserMedia / AudioWorklet / 静音断句 / 60s 上限）
 *   - 模型就绪检查与后台下载轮询
 *   - 串行转写队列：多段按入队顺序写入各自目标，不乱序
 *   - 停止语义矩阵（design.md D10）：
 *       手动点击 / 接管自停  → 冲刷尾段到目标光标处
 *       编辑自停 / 翻页 / busy → 丢弃未定稿尾段
 *   - dispose（热重载清理，E4）
 *
 * 本模块假定运行在浏览器（或注入了 window/document 全局的 jsdom）环境。
 */
import { TARGET_SAMPLE_RATE, MAX_RECORD_MS, encodeWav, linearResample, createSilenceSegmenter, joinDraft } from './pure.js';

export const API_BASE = '/dsh-voice-local/v1';

async function fetchModelStatus() {
  const res = await window.fetch(`${API_BASE}/model/status`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error?.message ?? `模型状态查询失败（HTTP ${res.status}）`);
  }
  return data;
}

async function startModelDownload() {
  const res = await window.fetch(`${API_BASE}/model/download`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error?.message ?? `模型下载启动失败（HTTP ${res.status}）`);
  }
  return data;
}

async function transcribeWav(wav) {
  const res = await window.fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: wav,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error?.message ?? `转写失败（HTTP ${res.status}）`);
  }
  return data.text ?? '';
}

/**
 * 目标适配器契约：
 *   id            唯一标识（'composer' | 'question:<key>:<index>'）
 *   live()        目标仍挂载且代次未过期（E2 per-write liveness）
 *   acceptsWrites() 目标当前可写（提问卡 busy/disabled 时 false → 丢弃）
 *   compose(text) 返回拼接后的完整新文本（光标插入语义在适配器内实现）
 *   write(text)   全文写入目标
 *   warn(reason)  写入被拒时的诊断回调（可空）
 */
function dropReason(target, alive) {
  if (!alive) return 'disposed';
  if (target === null || target === undefined) return 'no-target';
  if (!target.live()) return 'target-gone';
  if (!target.acceptsWrites()) return 'target-busy';
  return null;
}

export function createDictationController({ notify = () => {} } = {}) {
  // ---- 状态 ----
  let mode = 'idle'; // idle | recording | transcribing
  let err = '';
  let downloading = false;
  const subscribers = new Set();

  // ---- 会话 ----
  let session = null; // { target, audioContext, stream, source, node, segmenter, timer, workletUrl }
  let queue = Promise.resolve();
  let alive = true;

  // 启动/停止互斥与取消令牌（保留 v1 语义：启动未完成时可点击停止取消）
  let starting = false;
  let stopping = false;
  let startToken = 0;
  let pollTimer = null;

  function publish() {
    const snapshot = getState();
    for (const fn of subscribers) fn(snapshot);
  }

  function setMode(next) { mode = next; publish(); }
  function setErr(next) { err = next; publish(); }
  function setDownloading(next) { downloading = next; publish(); }
  function setStarting(next) { starting = next; publish(); }

  function getState() {
    return { mode, err, downloading, starting, recording: mode === 'recording' };
  }

  function subscribe(fn) {
    subscribers.add(fn);
    fn(getState());
    return () => subscribers.delete(fn);
  }

  // ---- 音频会话资源 ----
  function teardownSession(s) {
    if (s === null || s === undefined) return;
    if (s.timer !== undefined) window.clearTimeout(s.timer);
    try { s.node.disconnect(); } catch { /* noop */ }
    try { s.source.disconnect(); } catch { /* noop */ }
    s.stream.getTracks().forEach((track) => track.stop());
    if (s.audioContext.state !== 'closed') {
      s.audioContext.close().catch(() => {});
    }
    if (s.workletUrl !== undefined) {
      try { window.URL.revokeObjectURL(s.workletUrl); } catch { /* noop */ }
    }
  }

  // ---- 串行转写队列 ----
  function enqueueTranscription(target, samples) {
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
    const run = queue.then(async () => {
      try {
        const text = await transcribeWav(wav);
        const trimmed = (text ?? '').trim();
        if (trimmed === '') return;
        const reason = dropReason(target, alive);
        if (reason !== null) {
          if (reason !== 'disposed' && typeof target?.warn === 'function') target.warn(reason);
          return;
        }
        target.write(target.compose(trimmed));
      } catch (cause) {
        console.error('[dsh-voice-local] transcribe failed:', cause);
        notify(cause instanceof Error ? cause.message : String(cause), 'error');
        if (alive) { setErr(cause instanceof Error ? cause.message : String(cause)); }
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // ---- 停止 ----
  /**
   * @param {object} [opts]
   * @param {'flush'|'discard'} [opts.tail] 未定稿尾段处理（D10）
   * @param {boolean} [opts.awaitQueue] 是否等待队列清空后才回到 idle
   */
  async function stop({ tail = 'flush', awaitQueue = true } = {}) {
    if (stopping) return;
    // 启动流程尚未完成：取消本次启动（v1 语义——"以为停了其实还在录"防线）
    if (starting) {
      startToken += 1;
      setStarting(false);
      return;
    }
    const current = session;
    if (current === null || current === undefined) return;
    stopping = true;
    session = null;
    teardownSession(current);
    try {
      if (tail === 'flush') current.segmenter.flush();
      setMode('transcribing');
      setErr('');
      if (awaitQueue) await queue;
      if (!alive) return;
      setMode('idle');
    } catch (cause) {
      if (alive) {
        setErr(cause instanceof Error ? cause.message : String(cause));
        setMode('idle');
      }
    } finally {
      stopping = false;
    }
  }

  /** 编辑触发自停（开关开启时）：丢弃未定稿尾段。 */
  function stopForManualEdit() {
    if (mode !== 'recording') return;
    void stop({ tail: 'discard' });
  }

  /** 接管/翻页/目标消失等外部触发的停：默认冲刷（接管）或丢弃由调用方决定。 */
  function stopExternal({ tail = 'flush' } = {}) {
    if (mode !== 'recording') return;
    void stop({ tail });
  }

  // ---- 启动 ----
  async function start(target) {
    if (!alive) return;
    const current = session;
    const switching = current !== null && current !== undefined && current.target.id !== target.id;
    if (switching) {
      // 并发切换（D1）：立即冲刷旧目标尾段入队并释放其媒体资源，
      // 新目标马上走启动流程；旧队列写入按序落回旧目标。
      if (stopping || starting) return;
      session = null;
      teardownSession(current);
      current.segmenter.flush();
      setMode('idle');
    } else {
      if (mode !== 'idle' || stopping || starting) {
        console.warn('[dsh-voice-local] start declined', { target: target.id, mode, stopping, starting });
        return;
      }
    }

    setErr('');
    setStarting(true);
    const token = ++startToken;
    const cancelIfStale = () => token !== startToken || !alive;

    // 模型就绪检查；未就绪则触发后台下载并提示，不开始录音（v1 行为）
    try {
      const status = await fetchModelStatus();
      if (cancelIfStale()) { setStarting(false); return; }
      if (!status.ready) {
        setDownloading(true);
        if (status.download?.status !== 'downloading') {
          notify('首次使用需要下载模型（约 230MB），已开始后台下载…');
          await startModelDownload();
          if (cancelIfStale()) {
            setDownloading(false);
            setStarting(false);
            return;
          }
        } else {
          notify('模型正在下载中，请稍候…');
        }
        if (pollTimer !== null) window.clearInterval(pollTimer);
        pollTimer = window.setInterval(async () => {
          if (!alive || token !== startToken) {
            if (pollTimer !== null) window.clearInterval(pollTimer);
            return;
          }
          try {
            const st = await fetchModelStatus();
            if (token !== startToken || !alive) return;
            if (st.ready) {
              if (pollTimer !== null) window.clearInterval(pollTimer);
              setDownloading(false);
              notify('模型下载完成，可以开始录音');
            } else if (st.download?.status === 'error') {
              if (pollTimer !== null) window.clearInterval(pollTimer);
              setDownloading(false);
              notify(`模型下载失败：${st.download.error ?? '未知错误'}`, 'error');
            }
          } catch { /* 继续轮询 */ }
        }, 2000);
        setStarting(false);
        return;
      }
    } catch (cause) {
      setDownloading(false);
      notify(cause instanceof Error ? cause.message : String(cause), 'error');
      setErr(cause instanceof Error ? cause.message : String(cause));
      setStarting(false);
      return;
    }

    let stream = null;
    let audioContext = null;
    try {
      const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
      if (typeof AudioCtx !== 'function') {
        throw new Error('浏览器不支持 AudioWorklet，无法录音');
      }
      stream = await window.navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelIfStale()) {
        stream.getTracks().forEach((track) => track.stop());
        setStarting(false);
        return;
      }
      audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
      if (cancelIfStale()) {
        try { audioContext.close(); } catch { /* noop */ }
        stream.getTracks().forEach((track) => track.stop());
        setStarting(false);
        return;
      }
      if (!audioContext.audioWorklet || typeof audioContext.audioWorklet.addModule !== 'function') {
        try { audioContext.close(); } catch { /* noop */ }
        throw new Error('浏览器不支持 AudioWorklet，无法录音');
      }
      const source = audioContext.createMediaStreamSource(stream);
      const workletUrl = window.URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await audioContext.audioWorklet.addModule(workletUrl);
      if (cancelIfStale()) {
        try { audioContext.close(); } catch { /* noop */ }
        stream.getTracks().forEach((track) => track.stop());
        setStarting(false);
        return;
      }
      const node = new window.AudioWorkletNode(audioContext, 'dsh-voice-local-pcm');
      const segmenter = createSilenceSegmenter({
        sampleRate: TARGET_SAMPLE_RATE,
        onSegment: (samples) => { enqueueTranscription(target, samples); },
      });
      node.port.onmessage = (event) => {
        const input = event.data;
        if (!(input instanceof Float32Array) || input.length === 0) return;
        const resampled = audioContext.sampleRate === TARGET_SAMPLE_RATE
          ? input
          : linearResample(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
        segmenter.push(resampled);
      };
      source.connect(node);
      node.connect(audioContext.destination);
      const timer = window.setTimeout(() => { void stop({ tail: 'flush' }); }, MAX_RECORD_MS);
      session = { target, audioContext, stream, source, node, segmenter, timer, workletUrl };
      setMode('recording');
    } catch (cause) {
      console.error('[dsh-voice-local] startRecording failed:', cause);
      if (stream !== null) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (audioContext !== null && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
      }
      console.warn('[dsh-voice-local] start failed', cause);
      notify(cause instanceof Error ? cause.message : String(cause), 'error');
      setErr(cause instanceof Error ? cause.message : String(cause));
      setMode('idle');
    } finally {
      if (token === startToken) setStarting(false);
    }
  }

  /** 入口卸载时释放其目标：在录则静默停（不回填，匹配 v1 卸载语义），队列内旧写入因 live()=false 被丢弃。 */
  function releaseTarget(targetId) {
    if (session !== null && session !== undefined && session.target.id === targetId) {
      const current = session;
      session = null;
      teardownSession(current);
      if (mode === 'recording') setMode('idle');
    }
  }

  function dispose() {
    alive = false;
    if (pollTimer !== null) window.clearInterval(pollTimer);
    if (session !== null && session !== undefined) {
      const current = session;
      session = null;
      teardownSession(current);
    }
    subscribers.clear();
  }

  return {
    start,
    stop,
    stopForManualEdit,
    stopExternal,
    releaseTarget,
    dispose,
    subscribe,
    getState,
    get recordingTargetId() {
      return session !== null && session !== undefined ? session.target.id : null;
    },
  };
}

/** AudioWorklet PCM 采集源（blob URL 注入）。 */
export const WORKLET_SOURCE = `
  class DshVoiceLocalPCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      const channel = input && input[0];
      if (channel) {
        this.port.postMessage(new Float32Array(channel));
      }
      return true;
    }
  }
  registerProcessor('dsh-voice-local-pcm', DshVoiceLocalPCMProcessor);
`;
