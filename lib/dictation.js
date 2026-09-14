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

/**
 * 只读审计钩子（任务 9.4）：默认关闭；开启时记录写入与快捷键事件，供 issue 复现时 dump。
 * 内部排障设施、不属于行为契约——钩子失效不算违约；**绝不**调用任何 submit/发送路径。
 * 用法：`window.__dshVoiceLocalDebug = { enabled: true, events: [] }` 后再操作。
 */
export function recordVoiceDebug(kind, payload) {
  if (typeof window === 'undefined' || window === null) return;
  const hook = window.__dshVoiceLocalDebug;
  if (hook === null || hook === undefined || hook.enabled !== true) return;
  try {
    if (!Array.isArray(hook.events)) hook.events = [];
    hook.events.push({ t: Date.now(), kind, payload });
    if (hook.events.length > 200) hook.events.splice(0, hook.events.length - 200);
  } catch { /* 只读审计钩子失效不算违约 */ }
}

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

/**
 * 过滤器资产是否需要补齐（D3c）：`/model/status` 的 filters 里存在缺失或 0 字节资产。
 * 服务端不返回 filters（旧版本）时返回 false，避免无谓请求。
 */
export function filtersIncomplete(status) {
  const filters = status?.filters;
  if (filters === null || filters === undefined || typeof filters !== 'object') return false;
  const values = Object.values(filters);
  if (values.length === 0) return false;
  return values.some((f) => f === null || f === undefined || f.ready !== true || !(f.bytes > 0));
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
  // OV-4：守门判空时服务端附加 gateReason（无需 debug 开关），客户端据此给可读提示。
  return {
    text: data.text ?? '',
    gateReason: typeof data.gateReason === 'string' ? data.gateReason : null,
  };
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

export function createDictationController({
  notify = () => {},
  compositionTimeoutMs = 1000,
  compositionPollMs = 50,
} = {}) {
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
  // 守门判空可见性（OV-4）：同一录音会话内连续 2 段被判空 → 给一次可读提示（节流一次）。
  let gateMissStreak = 0;
  let gateHintShown = false;

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

  // ---- 录音目标注册表（design D5：白名单式解析，替代两个入口各自私藏 target） ----
  // 每项：{ id, target, element: () => Element|null, canStart: () => boolean, isComposer }
  // - 提问卡（非 composer）：命中其 textarea（含子树）才录向该卡；
  // - composer：焦点在主输入框子树内（含麦克风按钮本身）或页面无焦点时才录向主输入框；
  // - 其余一律 null（不触发、按键交还控件）。
  const targets = new Map();

  function registerTarget(entry) {
    if (entry === null || entry === undefined || typeof entry.id !== 'string') return () => {};
    targets.set(entry.id, entry);
    return () => unregisterTarget(entry.id);
  }

  function unregisterTarget(id) {
    targets.delete(id);
  }

  function activeElementOf() {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return doc?.activeElement ?? null;
  }

  function resolvesTo(entry, active) {
    if (typeof entry.element !== 'function') return false;
    const el = entry.element();
    if (el === null || el === undefined) return false;
    if (el === active) return true;
    if (active !== null && typeof el.contains === 'function' && el.contains(active)) return true;
    return false;
  }

  function resolveTarget() {
    const doc = typeof document !== 'undefined' ? document : undefined;
    if (doc === undefined) return null;
    const active = activeElementOf();
    // 1) 已注册的提问卡（白名单：未知控件永远不会被误劫持）
    for (const entry of targets.values()) {
      if (entry.isComposer === true) continue;
      if (resolvesTo(entry, active)) return entry.target;
    }
    // 2) 主输入框：[data-composer-card] 子树内（含麦克风按钮本身）或 body/null
    let composer = null;
    for (const entry of targets.values()) {
      if (entry.isComposer === true) { composer = entry; break; }
    }
    if (composer === null) return null;
    const card = typeof doc.querySelector === 'function' ? doc.querySelector('[data-composer-card]') : null;
    const inComposer = card !== null && active !== null && (card === active || (typeof card.contains === 'function' && card.contains(active)));
    const noFocus = active === null || active === doc.body;
    if (inComposer || noFocus) return composer.target;
    // 3) 其余可编辑控件 → 不触发
    return null;
  }

  /** 解析出的目标当前可否开始录音（可用性判定单一真源，评审 D3）。 */
  function canStartTarget(target) {
    if (target === null || target === undefined) return false;
    const entry = targets.get(target.id);
    if (entry === undefined || typeof entry.canStart !== 'function') return true;
    return entry.canStart() === true;
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
  /** 守门判空累计提示：连续 2 段判空给一次提示，同一会话只提示一次（OV-4）。 */
  function noteGateMiss() {
    gateMissStreak += 1;
    if (gateMissStreak >= 2 && !gateHintShown) {
      gateHintShown = true;
      notify('这一段没检测到人声，请靠近麦克风再说一次');
    }
  }

  /**
   * 写入前的 IME 组合期延后（任务 9.3）：目标处于输入法组合中时延后到组合结束，
   * **有界延后**（默认上限 1s）；超时或期间目标进入不可写的提交事务状态 → 丢弃该段
   * （与既有 busy 禁写即弃一致）。
   * @returns {Promise<boolean>} true=可写入，false=丢弃
   */
  async function waitForCompositionEnd(target) {
    const deadline = Date.now() + compositionTimeoutMs;
    for (;;) {
      if (typeof target?.isComposing !== 'function' || target.isComposing() !== true) return true;
      if (typeof target.live === 'function' && target.live() !== true) return false;
      if (typeof target.acceptsWrites === 'function' && target.acceptsWrites() !== true) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => { window.setTimeout(resolve, compositionPollMs); });
    }
  }

  function enqueueTranscription(target, samples) {
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
    const run = queue.then(async () => {
      try {
        const { text, gateReason } = await transcribeWav(wav);
        const trimmed = (text ?? '').trim();
        if (trimmed === '') {
          if (gateReason !== null) noteGateMiss();
          return;
        }
        gateMissStreak = 0; // 有正常结果即打断"连续判空"
        const reason = dropReason(target, alive);
        if (reason !== null) {
          if (reason !== 'disposed' && typeof target?.warn === 'function') target.warn(reason);
          return;
        }
        // 组合期延后（有界）：延后期间目标不可写或超时 → 丢弃该段。
        if (!(await waitForCompositionEnd(target))) {
          recordVoiceDebug('write-dropped', { target: target?.id ?? null, reason: 'composing' });
          return;
        }
        const next = target.compose(trimmed);
        recordVoiceDebug('write', { target: target?.id ?? null, length: next.length });
        target.write(next);
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
      // D3c 存量补齐：主模型已就绪但过滤器资产缺失/0 字节（例如 0.3.0 期间因地址
      // 错配从未下载成功）→ fire-and-forget 触发一次补下载。该路由幂等：主模型存在
      // 时走 already 分支且对非空资产跳过，因此不会重复下载主模型，也不阻塞录音。
      if (filtersIncomplete(status)) {
        void startModelDownload().catch(() => { /* 补齐失败仍 fail-open，不影响录音 */ });
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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      gateMissStreak = 0;   // 新会话：判空提示计数与节流窗口重置
      gateHintShown = false;
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
    registerTarget,
    unregisterTarget,
    resolveTarget,
    canStartTarget,
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
