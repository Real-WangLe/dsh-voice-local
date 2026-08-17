/**
 * dsh-voice-local web 端（client 插件）：
 * 输入框左侧加麦克风按钮 → AudioWorklet 录音 → 浏览器静音检测分段 →
 * 逐段 POST /dsh-voice-local/v1/transcribe → 按顺序追加到输入框草稿。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-local',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-voice-local/v1';
    const MAX_RECORD_MS = 60_000; // 60s 上限
    const TARGET_SAMPLE_RATE = 16000;
    const SILENCE_MS = 700;
    const MIN_SEGMENT_MS = 300;
    const RMS_THRESHOLD = 0.01;

    const css = `
      .dsv-local-button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
      .dsv-local-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      .dsv-local-button:disabled{opacity:.4;cursor:default}
      .dsv-local-button[data-recording=true]{background:var(--dsw-alias-state-error-primary);color:#fff}
      .dsv-local-button[data-recording=true]:hover{background:var(--dsw-alias-state-error-primary);color:#fff}
      .dsv-local-rec{width:11px;height:11px;border-radius:3px;background:#fff;animation:dsv-local-pulse 1.2s ease-in-out infinite}
      @keyframes dsv-local-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      .dsv-local-spinner{width:13px;height:13px;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:dsv-local-spin .8s linear infinite}
      @keyframes dsv-local-spin{to{transform:rotate(360deg)}}
      .dsv-local-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100;max-width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;pointer-events:none;opacity:0;transition:opacity .18s ease}
      .dsv-local-toast[data-show=true]{opacity:1}
      .dsv-local-toast[data-kind=error]{border-color:var(--dsw-alias-state-error-primary)}
    `;

    if (document.querySelector('style[data-plugin-css="dsh-voice-local"]') === null) {
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-voice-local';
      style.dataset.pluginCss = 'dsh-voice-local';
      style.textContent = css;
      document.head.appendChild(style);
    }

    // ---------- pure helpers (与 lib/pure.js 保持一致，便于浏览器直接运行) ----------
    function concatFloat32(chunks) {
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

    function linearResample(input, fromRate, toRate) {
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

    function encodeWav(samples, sampleRate) {
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

    function computeRms(samples) {
      if (samples.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i] ?? 0;
        sum += s * s;
      }
      return Math.sqrt(sum / samples.length);
    }

    function joinDraft(draft, text) {
      const last = draft.length > 0 ? draft[draft.length - 1] : '';
      const first = text.length > 0 ? text[0] : '';
      const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
      const sep = isWord(last) && isWord(first) ? ' ' : '';
      return `${draft}${sep}${text}`;
    }

    function createSilenceSegmenter({ sampleRate = TARGET_SAMPLE_RATE, rmsThreshold = RMS_THRESHOLD, silenceMs = SILENCE_MS, minSegmentMs = MIN_SEGMENT_MS, onSegment }) {
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
          if (!speaking) return;
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

    // ---------- toast ----------
    function showToast(message, kind = 'info') {
      const toast = document.createElement('div');
      toast.className = 'dsv-local-toast';
      toast.dataset.kind = kind;
      toast.textContent = message;
      document.body.appendChild(toast);
      window.requestAnimationFrame(() => { toast.dataset.show = 'true'; });
      window.setTimeout(() => {
        toast.dataset.show = 'false';
        window.setTimeout(() => toast.remove(), 220);
      }, 4000);
    }

    function showError(cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      showToast(message, 'error');
    }

    // ---------- host API ----------
    async function fetchModelStatus() {
      const res = await window.fetch(`${API}/model/status`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `模型状态查询失败（HTTP ${res.status}）`);
      }
      return data;
    }

    async function startModelDownload() {
      const res = await window.fetch(`${API}/model/download`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `模型下载启动失败（HTTP ${res.status}）`);
      }
      return data;
    }

    async function transcribe(wav) {
      const res = await window.fetch(`${API}/transcribe`, {
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

    // ---------- audio worklet source ----------
    const WORKLET_SOURCE = `
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

    // ---------- mic glyph ----------
    function MicGlyph() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 23, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('line', { x1: 8, y1: 23, x2: 16, y2: 23, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }));
    }

    // ---------- mic button ----------
    function MicButton({ inputActions, useInput, readDraft }) {
      const [mode, setMode] = React.useState('idle'); // idle | recording | transcribing
      const [err, setErr] = React.useState('');
      const [downloading, setDownloading] = React.useState(false);
      const modeRef = React.useRef('idle');
      modeRef.current = mode;
      const aliveRef = React.useRef(true);
      const sessionRef = React.useRef(null);
      const transcribeQueueRef = React.useRef(Promise.resolve());
      const stoppingRef = React.useRef(false);
      const startingRef = React.useRef(false);
      const startTokenRef = React.useRef(0);
      const pollTimerRef = React.useRef(null);
      const inputActionsRef = React.useRef(inputActions);
      inputActionsRef.current = inputActions;
      const readDraftRef = React.useRef(readDraft);
      readDraftRef.current = readDraft;

      const phase = useInput === undefined ? 'plain' : (useInput((snapshot) => snapshot?.phase ?? 'plain') || 'plain');
      const locked = phase !== 'plain';

      function teardownSession(session) {
        if (session === null || session === undefined) return;
        if (session.timer !== undefined) window.clearTimeout(session.timer);
        try { session.node.disconnect(); } catch { /* noop */ }
        try { session.source.disconnect(); } catch { /* noop */ }
        session.stream.getTracks().forEach((track) => track.stop());
        if (session.audioContext.state !== 'closed') {
          session.audioContext.close().catch(() => {});
        }
        if (session.workletUrl !== undefined) {
          try { window.URL.revokeObjectURL(session.workletUrl); } catch { /* noop */ }
        }
      }

      function enqueueTranscription(samples) {
        const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
        const run = transcribeQueueRef.current.then(async () => {
          try {
            const text = await transcribe(wav);
            if (!aliveRef.current) return;
            const trimmed = (text ?? '').trim();
            if (trimmed === '') return;
            const draft = readDraftRef.current ? readDraftRef.current() : '';
            const next = joinDraft(draft, trimmed);
            if (inputActionsRef.current && typeof inputActionsRef.current.setDraft === 'function') {
              inputActionsRef.current.setDraft(next);
            }
          } catch (cause) {
            console.error('[dsh-voice-local] transcribe failed:', cause);
            showError(cause);
          }
        });
        transcribeQueueRef.current = run.catch(() => {});
        return run;
      }

      const stopRecording = React.useCallback(async () => {
        if (stoppingRef.current) return;
        // 开始流程尚未完成时，取消本次启动，避免“以为停了其实还在录”
        if (startingRef.current) {
          startTokenRef.current += 1;
          startingRef.current = false;
          return;
        }
        const session = sessionRef.current;
        if (session === null || session === undefined) return;
        stoppingRef.current = true;
        sessionRef.current = null;
        teardownSession(session);
        try {
          session.segmenter.flush();
          setMode('transcribing');
          setErr('');
          await transcribeQueueRef.current;
          if (!aliveRef.current) return;
          setMode('idle');
        } catch (cause) {
          if (aliveRef.current) {
            setErr(cause instanceof Error ? cause.message : String(cause));
            setMode('idle');
          }
        } finally {
          stoppingRef.current = false;
        }
      }, []);

      const startRecording = React.useCallback(async () => {
        if (modeRef.current !== 'idle' || stoppingRef.current || startingRef.current) return;
        setErr('');
        startingRef.current = true;
        const token = ++startTokenRef.current;
        const cancelIfStale = () => token !== startTokenRef.current;

        // 模型就绪检查；未就绪则触发后台下载并提示，不开始录音
        try {
          const status = await fetchModelStatus();
          if (cancelIfStale()) return;
          if (!status.ready) {
            setDownloading(true);
            if (status.download?.status !== 'downloading') {
              showToast('首次使用需要下载模型（约 230MB），已开始后台下载…');
              await startModelDownload();
              if (cancelIfStale()) {
                setDownloading(false);
                return;
              }
            } else {
              showToast('模型正在下载中，请稍候…');
            }
            if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = window.setInterval(async () => {
              if (!aliveRef.current || cancelIfStale()) {
                if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
                return;
              }
              try {
                const st = await fetchModelStatus();
                if (cancelIfStale()) return;
                if (st.ready) {
                  if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
                  setDownloading(false);
                  showToast('模型下载完成，可以开始录音');
                } else if (st.download?.status === 'error') {
                  if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
                  setDownloading(false);
                  showToast(`模型下载失败：${st.download.error ?? '未知错误'}`, 'error');
                }
              } catch { /* 继续轮询 */ }
            }, 2000);
            if (token === startTokenRef.current) startingRef.current = false;
            return;
          }
        } catch (cause) {
          setDownloading(false);
          showError(cause);
          if (token === startTokenRef.current) startingRef.current = false;
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
            return;
          }
          audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
          if (cancelIfStale()) {
            try { audioContext.close(); } catch { /* noop */ }
            stream.getTracks().forEach((track) => track.stop());
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
            return;
          }
          const node = new window.AudioWorkletNode(audioContext, 'dsh-voice-local-pcm');
          const segmenter = createSilenceSegmenter({
            sampleRate: TARGET_SAMPLE_RATE,
            rmsThreshold: RMS_THRESHOLD,
            silenceMs: SILENCE_MS,
            minSegmentMs: MIN_SEGMENT_MS,
            onSegment: (samples) => { void enqueueTranscription(samples); },
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
          const timer = window.setTimeout(() => { void stopRecording(); }, MAX_RECORD_MS);
          sessionRef.current = {
            audioContext,
            stream,
            source,
            node,
            segmenter,
            timer,
            workletUrl,
          };
          setMode('recording');
        } catch (cause) {
          console.error('[dsh-voice-local] startRecording failed:', cause);
          if (stream !== null) {
            stream.getTracks().forEach((track) => track.stop());
          }
          if (audioContext !== null && audioContext.state !== 'closed') {
            audioContext.close().catch(() => {});
          }
          showError(cause);
          setErr(cause instanceof Error ? cause.message : String(cause));
          setMode('idle');
        } finally {
          if (token === startTokenRef.current) startingRef.current = false;
        }
      }, [stopRecording]);

      // 生命周期：组件卸载时停止并释放资源（不向错误会话回填）
      React.useEffect(() => () => {
        aliveRef.current = false;
        if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
        const session = sessionRef.current;
        if (session !== null && session !== undefined) {
          sessionRef.current = null;
          teardownSession(session);
        }
      }, []);

      // composer 锁定/提交时若正在录音则停止并冲刷
      React.useEffect(() => {
        if (phase !== 'plain' && modeRef.current === 'recording') {
          void stopRecording();
        }
      }, [phase, stopRecording]);

      const title = downloading
        ? '模型下载中…'
        : mode === 'recording'
          ? '点击停止并转写'
          : mode === 'transcribing'
            ? '正在转写…'
            : err || '语音输入（本地转写，音频不出本机）';

      const disabled = mode === 'recording' ? false : (locked || mode === 'transcribing' || downloading);

      return h('button', {
        type: 'button',
        className: 'dsv-local-button',
        title,
        'aria-label': title,
        'data-recording': mode === 'recording',
        disabled,
        onClick: () => {
          if (mode === 'idle') {
            if (startingRef.current) void stopRecording();
            else void startRecording();
          } else if (mode === 'recording') {
            void stopRecording();
          }
        },
      }, mode === 'recording'
        ? h('span', { className: 'dsv-local-rec', 'aria-hidden': true })
        : mode === 'transcribing'
          ? h('span', { className: 'dsv-local-spinner', 'aria-hidden': true })
          : h(MicGlyph));
    }

    // ---------- apply ----------
    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const conversation = ctx.get('conversation');

      function readDraft(sessionId) {
        const actx = sessions.scope(sessionId);
        if (actx === undefined) return '';
        const input = conversation.input.for(actx);
        if (input?.state?.getSnapshot === undefined) return '';
        const snapshot = input.state.getSnapshot();
        return typeof snapshot?.draft === 'string' ? snapshot.draft : '';
      }

      ctx.inject(['slots', 'conversation', 'sessions'], (scope) => {
        scope.slots.inject('conversation.input.left', () => scope.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-voice-local-button',
          order: -100,
          inject: (sessionId) => ({
            readDraft: () => readDraft(sessionId),
          }),
        }, MicButton));
      });
    }

    return { apply, inject: ['slots', 'conversation', 'sessions'] };
  },
});
