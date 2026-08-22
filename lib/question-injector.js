/**
 * dsh-voice-local 浏览器端：提问卡片语音入口注入器。
 *
 * 监听 [data-composer-seat]（回退 body，D6）内出现的 [data-question-key]
 * 卡片帧，在当前问题的自定义回答 textarea 旁注入麦克风控件（与主输入框
 * 同一套控制器/断句/队列/自停语义）。识别文本经 React 受控通道写入：
 * native value setter + 冒泡 input 事件 → 宿主 onChange 更新内部 state。
 *
 * 语义锚点（design.md）：
 *   - D3 busy 禁写即弃：textarea disabled 时到达的段落在写入前被拒并停录
 *   - D7 翻页/关闭 = releaseTarget：停止录音且丢弃未定稿尾段（不跨题残留）
 *   - E2 per-write liveness：每次写入前校验目标仍挂载
 *   - E3 fail-open：找不到注入点时 console.warn 单次诊断，不影响宿主卡片
 */
import { composeInsertion } from './pure.js';
import { attachManualEditGuard, readAutoStopPref, writeAutoStopPref } from './manual-edit.js';

const GLYPH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  + '<line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** 原生 DOM 麦克风控件：麦克风按钮 + ⋮ 配置菜单；状态镜像 controller.subscribe。 */
function createMicControl({ controller, makeTarget, guardContainer }) {
  const wrap = document.createElement('span');
  wrap.className = 'dsv-local-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dsv-local-button';
  btn.title = '语音输入';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = GLYPH_SVG;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'dsv-local-ellipsis';
  more.title = '语音设置';
  more.setAttribute('aria-label', '语音设置');
  more.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  const menu = document.createElement('div');
  menu.className = 'dsv-local-menu';
  menu.style.display = 'none';
  const desc = document.createElement('div');
  desc.className = 'dsv-local-menu-desc';
  desc.textContent = '语音输入（本地转写，音频不出本机）';
  const row = document.createElement('label');
  row.className = 'dsv-local-menu-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = readAutoStopPref();
  box.addEventListener('change', () => writeAutoStopPref(box.checked));
  row.appendChild(box);
  row.appendChild(document.createTextNode('键盘输入自动关闭麦克风'));
  menu.appendChild(desc);
  menu.appendChild(row);
  wrap.appendChild(btn);
  wrap.appendChild(more);
  wrap.appendChild(menu);

  let targetRef = null; // 首次启动时经 makeTarget() 构造

  function render(s) {
    btn.dataset.recording = s.mode === 'recording' ? 'true' : 'false';
    btn.disabled = s.mode === 'recording'
      ? false
      : (s.mode === 'transcribing' || s.downloading);
    more.disabled = btn.disabled;
    btn.title = s.downloading
      ? '模型下载中…'
      : s.mode === 'recording'
        ? '点击停止并转写'
        : s.mode === 'transcribing'
          ? '正在转写…'
          : (s.mode === 'idle' && s.starting)
            ? '等待麦克风授权…'
            : (s.err || '语音输入');
    // 显式 glyph 切换：不依赖 CSS 变红，状态一变就能看到反馈
    if (s.mode === 'recording') {
      btn.innerHTML = '<span class="dsv-local-rec" aria-hidden="true"></span>';
    } else if (s.mode === 'transcribing') {
      btn.innerHTML = '<span class="dsv-local-spinner" aria-hidden="true"></span>';
    } else {
      btn.innerHTML = GLYPH_SVG;
    }
  }
  const unsubscribe = controller.subscribe(render);

  // 编辑自停守卫：挂在宿主卡片帧容器上（E1）
  attachManualEditGuard({
    container: guardContainer,
    armed: () => {
      const t = targetRef;
      return box.checked === true
        && controller.getState().mode === 'recording'
        && t !== null
        && controller.recordingTargetId === t.id;
    },
    onEdit: () => controller.stopForManualEdit(),
  });

  function closeMenu() { menu.style.display = 'none'; }
  function toggleMenu(event) {
    if (event !== undefined) event.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  }
  more.addEventListener('click', toggleMenu);
  document.addEventListener('mousedown', (event) => {
    if (menu.style.display !== 'none' && !wrap.contains(event.target)) closeMenu();
  }, true);

  btn.addEventListener('click', () => {
    if (targetRef === null || !targetRef.live()) targetRef = makeTarget();
    const live = controller.getState();
    if (live.mode === 'idle') {
      if (live.starting) void controller.stop({ tail: 'flush' });
      else void controller.start(targetRef);
    } else if (live.mode === 'recording') {
      void controller.stop({ tail: 'flush' });
    }
  });

  return {
    el: wrap,
    dispose() {
      unsubscribe();
    },
  };
}

/** 从提问卡帧内解析当前页码（如 "2 / 3"）；解析不到返回 null。 */
function readQuestionIndex(frame) {
  for (const el of frame.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim();
    const m = /^(\d+)\s*\/\s*\d+$/.exec(text);
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/** 为一个自定义回答 textarea 构建目标适配器（含受控写入与 liveness）。 */
function createQuestionTarget(ta, key, warnOnce) {
  let currentTa = ta; // React 重渲染可能替换 textarea 节点；同题替换时 retarget 保持录音
  const pending = { caret: undefined };
  return {
    id: `question:${key}`,
    live: () => currentTa.isConnected === true,
    acceptsWrites: () => currentTa.disabled !== true,
    warn: warnOnce,
    read: () => currentTa.value,
    compose: (text) => {
      const base = currentTa.value;
      // 失焦时 selectionStart=0 会写到最开头；仅获焦时用光标，否则回退末尾追加
      const focused = currentTa === document.activeElement && typeof currentTa.selectionStart === 'number';
      const caret = focused ? currentTa.selectionStart : base.length;
      const result = composeInsertion({ text: base, caret, insert: text });
      pending.caret = result.caret;
      return result.value;
    },
    write: (next) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(currentTa, next);
      currentTa.dispatchEvent(new window.Event('input', { bubbles: true }));
      const c = pending.caret;
      pending.caret = undefined;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (currentTa.isConnected && currentTa.value.length >= c) {
          try { currentTa.setSelectionRange(c, c); } catch { /* noop */ }
        }
      }));
    },
    retarget(nextNode) {
      if (currentTa === nextNode) return false;
      currentTa = nextNode;
      console.warn(`[dsh-voice-local] question ${key} textarea retargeted (same-question re-render)`);
      return true;
    },
  };
}

export function createQuestionInjector({ controller }) {
  let observer = null;
  let rescanTimer = null;
  let observingBodyFallback = false;
  const entries = new Map(); // key -> { frame, control, target, detachGuard }
  const warnedKeys = new Set();

  function resolveContainer() {
    const seat = document.querySelector('[data-composer-seat]');
    if (seat !== null) return { container: seat, isSeat: true };
    return { container: document.body, isSeat: false };
  }

  function warnOnce(key, reason) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn(`[dsh-voice-local] question card ${key}: ${reason}`);
  }

  /** 找到当前问题帧内的自定义回答 textarea 及其注入挂点。 */
  function locateAnswerField(frame) {
    const ta = frame.querySelector('textarea');
    if (ta === null) return null;
    const fieldDiv = ta.parentElement;
    const rowDiv = fieldDiv !== null ? fieldDiv.parentElement : null;
    if (rowDiv === null) return null;
    const inline = Array.from(rowDiv.children).some((el) => el !== fieldDiv);
    return { ta, fieldDiv, rowDiv, inline };
  }

  function mount(frame) {
    try { mountInner(frame); } catch (cause) { console.error('[dsh-voice-local] question mount failed:', cause); }
  }
  function mountInner(frame) {
    const key = frame.getAttribute('data-question-key') ?? 'unknown';
    if (entries.has(key)) return;
    const located = locateAnswerField(frame);
    if (located === null) {
      warnOnce(key, 'custom answer textarea not found; voice entry skipped (fail-open)');
      return;
    }
    const { ta, fieldDiv, rowDiv, inline } = located;
    const target = createQuestionTarget(ta, key, (reason) => warnOnce(key, reason));
    const control = createMicControl({
      controller,
      guardContainer: frame,
      makeTarget: () => target,
    });
    if (inline) {
      rowDiv.insertBefore(control.el, fieldDiv.nextSibling);
      control.el.style.flex = '0 0 auto';
    } else {
      rowDiv.appendChild(control.el);
      control.el.style.alignSelf = 'flex-end';
      control.el.style.marginRight = '12px';
    }
    const questionIndex = readQuestionIndex(frame);
    entries.set(key, { frame, control, target, questionIndex });
  }

  function unmount(key) {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    // 录音会话属于该卡 → 释放即静默停止并丢尾段（D7 不跨题残留）
    if (controller.recordingTargetId === entry.target.id) {
      console.warn('[dsh-voice-local] question card changed while recording; session released (tail discarded)');
      controller.releaseTarget(entry.target.id);
    }
    entry.control.dispose();
    if (entry.control.el.isConnected) entry.control.el.remove();
  }

  function sync() {
    try { syncInner(); } catch (cause) { console.error('[dsh-voice-local] sync failed:', cause); }
  }
  function syncInner() {
    // 升级到 seat 容器（D6）：body 回退状态下发现 seat 即重连
    if (observingBodyFallback && observer !== null) {
      const seat = document.querySelector('[data-composer-seat]');
      if (seat !== null) {
        observer.disconnect();
        connect(seat);
        return;
      }
    }
    const presentKeys = new Set();
    for (const frame of document.querySelectorAll('[data-question-key]')) {
      const key = frame.getAttribute('data-question-key') ?? 'unknown';
      presentKeys.add(key);
      const entry = entries.get(key);
      if (entry === undefined) {
        mount(frame);
        continue;
      }
      // 页码变化=真正翻页 → 停止并丢弃，重建入口（D7 不跨题残留）
      const currentIndex = readQuestionIndex(frame);
      if (currentIndex !== null && entry.questionIndex !== currentIndex) {
        unmount(key);
        mount(frame);
        continue;
      }
      // 宿主重渲染可能替换 textarea 节点：同题内节点替换 → retarget 保持录音会话
      if (!entry.target.live()) {
        const located = locateAnswerField(frame);
        if (located !== null) {
          entry.target.retarget(located.ta);
          entry.questionIndex = currentIndex;
          continue;
        }
      }
      // busy 禁写即弃（D3）：本卡录音中回答框被禁用（提交中）→ 丢弃尾段并停录
      if (
        controller.recordingTargetId === entry.target.id
        && !entry.target.acceptsWrites()
      ) {
        controller.stopExternal({ tail: 'discard' });
      }
    }
    // 消失的帧 → 清理（翻页/关闭：停止且丢弃未定稿尾段）
    for (const key of Array.from(entries.keys())) {
      if (!presentKeys.has(key)) unmount(key);
    }
  }

  function connect(container) {
    observingBodyFallback = container === document.body || container === null;
    const MO = typeof MutationObserver !== 'undefined' ? MutationObserver : window.MutationObserver;
    if (typeof MO !== 'function') {
      console.warn('[dsh-voice-local] MutationObserver unavailable; question voice entry disabled (fail-open)');
      observer = null;
      return;
    }
    observer = new MO(() => { sync(); });
    if (observer === null) return;
    observer.observe(container === null ? document.body : container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    sync();
  }

  function start() {
    if (observer !== null) return;
    try {
      const { container } = resolveContainer();
      connect(container);
      // 兜底重扫：MutationObserver 理论可靠，但真实宿主卡片可能有异步挂载/Portal
      // 时序差异；低频全量 sync 保证 ≤2s 内追上（D6 性能权衡，查询开销极小）。
      rescanTimer = window.setInterval(() => { try { sync(); } catch { /* keep alive */ } }, 2000);
    } catch (cause) {
      console.warn('[dsh-voice-local] question injector failed to start:', cause);
    }
  }

  function dispose() {
    if (observer !== null) { observer.disconnect(); observer = null; }
    for (const key of Array.from(entries.keys())) unmount(key, 'injector disposed');
  }

  return { start, dispose, _entries: entries };
}
