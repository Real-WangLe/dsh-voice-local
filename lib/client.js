/**
 * dsh-voice-local web 端（client 插件入口）：
 * 输入框工具行麦克风按钮（薄壳）→ 共享听写控制器（dictation.js）→
 * AudioWorklet 录音 → 浏览器静音检测分段 → 逐段转写 → 光标处写入输入目标。
 *
 * 提问卡片入口由 question-injector.js 注入，与本入口共享同一控制器。
 */
import { joinDraft, composeInsertion } from './pure.js';
import { createDictationController, recordVoiceDebug } from './dictation.js';
import { attachManualEditGuard, readAutoStopPref, writeAutoStopPref } from './manual-edit.js';
import { attachHotkey, readHotkeyPref, writeHotkeyPref, formatHotkey, captureHotkey, DEFAULT_HOTKEY } from './hotkey.js';
import { createQuestionInjector } from './question-injector.js';

window.__ModuleLoader__.load({
  id: 'dsh-voice-local',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const COMPOSER_TARGET_ID = 'composer';

    /** 元素是否可见（过滤 display:none / hidden 的接管态输入栏）。 */
    function isElementVisible(el) {
      if (el === null || el === undefined || el.isConnected !== true || el.hidden === true) return false;
      if (typeof window.getComputedStyle !== 'function') return true;
      try {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      } catch {
        return true;
      }
    }

    /** composer seat 内是否存在接管卡（提问/审批/计划审阅）——主输入框此时不可提交。 */
    function seatHasTakeoverCard() {
      const seat = document.querySelector('[data-composer-seat]');
      if (seat === null) return false;
      return seat.querySelector('[data-question-key],[data-plan-review-key],[data-approval-key]') !== null;
    }

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
      .dsv-local-wrap{position:relative;display:inline-flex}
      .dsv-local-ellipsis{width:24px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
      .dsv-local-ellipsis:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      .dsv-local-ellipsis:disabled{opacity:.4;cursor:default}
      .dsv-local-menu{position:absolute;bottom:calc(100% + 6px);left:100%;margin-left:4px;z-index:60;min-width:228px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
      .dsv-local-menu-desc{margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
      .dsv-local-menu-row{display:flex;align-items:center;gap:6px;white-space:nowrap}
      .dsv-local-menu-row input{accent-color:var(--dsw-alias-state-business-primary);margin:0;cursor:pointer}
      .dsv-local-menu-hotkey{justify-content:space-between;margin-top:6px;gap:8px}
      .dsv-local-hotkey-chip{flex:0 0 auto;min-width:74px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
      .dsv-local-hotkey-chip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
      .dsv-local-hotkey-chip[data-capturing=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
      .dsv-local-hotkey-clear{flex:0 0 auto;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;padding:0}
      .dsv-local-hotkey-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      .dsv-local-hotkey-hint{margin-top:4px;color:var(--dsw-alias-state-warning-primary,#b26a00);font-size:11px;line-height:16px;white-space:normal}
    `;

    let style = document.querySelector('style[data-plugin-css="dsh-voice-local"]');
    if (style === null) {
      style = document.createElement('style');
      style.dataset.plugin = 'dsh-voice-local';
      style.dataset.pluginCss = 'dsh-voice-local';
      document.head.appendChild(style);
    }
    style.textContent = css; // 存在即更新：热重载/刷新后新样式立即生效

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

    // ---------- 共享控制器单例（E4：热重载先清旧例） ----------
    const CONTROLLER_KEY = '__dshVoiceLocalDictation__';
    function getSharedController() {
      const existing = window[CONTROLLER_KEY];
      if (existing) return existing;
      const controller = createDictationController({ notify: showToast });
      window[CONTROLLER_KEY] = controller;
      return controller;
    }

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

    // ---------- composer 目标适配器 ----------
    /** 读取主 composer textarea 的光标位置；拿不到（结构变化/jsdom）返回 null → 回退末尾追加。 */
    function readComposerCaret() {
      const ta = document.querySelector('[data-composer-card] textarea');
      // 只有输入框真正持有焦点时才用其光标；失焦时 selectionStart=0 会把语音写到草稿最开头
      if (ta === null || !ta.isConnected || ta !== document.activeElement || typeof ta.selectionStart !== 'number') return null;
      return ta.selectionStart;
    }

    /** 写入并经宿主 React 提交后，把光标放回插入文本末尾（双 rAF 等 commit）。 */
    function restoreComposerCaret(caret) {
      if (typeof caret !== 'number') return;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const ta = document.querySelector('[data-composer-card] textarea');
        if (ta !== null && ta.value.length >= caret) {
          try { ta.setSelectionRange(caret, caret); } catch { /* noop */ }
        }
      }));
    }

    function createComposerTarget({ readDraft, inputActionsRef }) {
      const pending = { caret: undefined };
      let composing = false; // 由 MicButton 在 composer 卡片上挂的 composition 监听同步（任务 9.3）
      return {
        id: COMPOSER_TARGET_ID,
        live: () => true,
        acceptsWrites: () => true,
        isComposing: () => composing,
        setComposing: (value) => { composing = value === true; },
        read: () => readDraft(),
        compose: (text) => {
          const base = readDraft();
          const caret = readComposerCaret();
          if (caret === null) {
            pending.caret = undefined;
            return joinDraft(base, text); // 无 DOM 光标信息：v1 追加语义
          }
          const result = composeInsertion({ text: base, caret, insert: text });
          pending.caret = result.caret;
          return result.value;
        },
        write: (next) => {
          const actions = inputActionsRef.current;
          if (actions && typeof actions.setDraft === 'function') actions.setDraft(next);
          restoreComposerCaret(pending.caret);
          pending.caret = undefined;
        },
      };
    }

    // ---------- EllipsisGlyph（⋮ 配置菜单入口） ----------
    function EllipsisGlyph() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 5, r: 2 }),
        h('circle', { cx: 12, cy: 12, r: 2 }),
        h('circle', { cx: 12, cy: 19, r: 2 }));
    }

    /** 合并提示：按钮 title 只保留角色名，详细说明与开关放进三点菜单。 */
    function micTitle(mode, err, downloading, starting) {
      if (downloading) return '模型下载中…';
      if (mode === 'recording') return '点击停止并转写';
      if (mode === 'transcribing') return '正在转写…';
      if (mode === 'idle' && starting) return '等待麦克风授权…';
      return (err || '语音输入');
    }

    // ---------- mic button（薄壳：状态镜像 + 渲染 + 交互） ----------
    function MicButton({ inputActions, useInput, readDraft }) {
      const controller = getSharedController();
      const [state, setState] = React.useState(controller.getState());
      React.useEffect(() => controller.subscribe(setState), [controller]);

      // 自停开关（三点菜单；localStorage 持久化，默认开）
      const [autoStop, setAutoStop] = React.useState(() => readAutoStopPref());
      const autoStopRef = React.useRef(autoStop);
      autoStopRef.current = autoStop;
      const [menuOpen, setMenuOpen] = React.useState(false);
      const wrapRef = React.useRef(null);

      const inputActionsRef = React.useRef(inputActions);
      inputActionsRef.current = inputActions;
      const readDraftRef = React.useRef(readDraft);
      readDraftRef.current = readDraft;
      const btnRef = React.useRef(null);
      const targetRef = React.useRef(null);
      if (targetRef.current === null) {
        targetRef.current = createComposerTarget({
          readDraft: () => readDraftRef.current(),
          inputActionsRef,
        });
      }

      const phase = useInput === undefined ? 'plain' : (useInput((snapshot) => snapshot?.phase ?? 'plain') || 'plain');
      const locked = phase !== 'plain';
      // 用 ref 把 locked 同步给目标注册项，让快捷键与按钮读同一份可用性判定（评审 D3），
      // 不改变 React 结构。
      const lockedRef = React.useRef(false);
      lockedRef.current = locked;

      // 快捷键偏好与捕获态（捕获态期间全局监听挂起，按键交给捕获控件消费）
      const [hotkey, setHotkey] = React.useState(() => readHotkeyPref());
      const hotkeyRef = React.useRef(hotkey);
      hotkeyRef.current = hotkey;
      const [capturing, setCapturing] = React.useState(false);
      const captureRef = React.useRef(false);
      captureRef.current = capturing;
      const [hotkeyNote, setHotkeyNote] = React.useState('');

      /** 主输入框当前是否处于可写（可提交）状态：phase=plain 且卡片可见。 */
      const composerWritable = React.useCallback(() => {
        if (lockedRef.current) return false; // 接管卡片 / 提交事务：不可写
        const card = document.querySelector('[data-composer-card]');
        return card !== null && isElementVisible(card);
      }, []);

      /** 主输入框"当前可否开始录音"的单一真源：按钮 disabled 与快捷键启动都读它。 */
      const composerCanStart = React.useCallback(() => {
        if (!composerWritable()) return false;
        const live = controller.getState();
        if (live.mode !== 'idle' || live.downloading === true) return false;
        if (seatHasTakeoverCard()) return false; // 接管卡弹出时不得启动（防"闪一下"）
        return true;
      }, [controller, composerWritable]);

      // 目标注册（D5）：文档级快捷键按焦点解析时命中主输入框即录向它。
      React.useEffect(() => {
        const unregister = controller.registerTarget({
          id: COMPOSER_TARGET_ID,
          target: targetRef.current,
          isComposer: true,
          canStart: composerCanStart,
        });
        return () => {
          unregister();
          controller.releaseTarget(COMPOSER_TARGET_ID); // 卸载即静默停、不回填（v1 语义）
        };
      }, [controller, composerCanStart]);

      // 全局快捷键（D6/D7）：触发语义与点击麦克风完全同义；preventDefault 只在
      // 目标解析成功且可动作后执行（OV-11）——否则放行按键交还控件。
      React.useEffect(() => attachHotkey({
        getHotkey: () => hotkeyRef.current,
        active: () => captureRef.current === false,
        onTrigger: () => {
          const live = controller.getState();
          if (live.mode === 'idle' && live.starting) {
            recordVoiceDebug('hotkey', { action: 'cancel-start' });
            void controller.stop({ tail: 'flush' }); // 启动未完成 → 取消本次启动
            return true;
          }
          if (live.mode === 'recording') {
            recordVoiceDebug('hotkey', { action: 'stop' });
            void controller.stop({ tail: 'flush' }); // 与点击同义：停止并冲刷
            return true;
          }
          if (live.mode !== 'idle' || live.downloading === true) {
            recordVoiceDebug('hotkey', { action: 'ignore', mode: live.mode, downloading: live.downloading });
            return false; // 转写/下载中：忽略
          }
          const target = controller.resolveTarget();
          if (target === null || !controller.canStartTarget(target)) {
            recordVoiceDebug('hotkey', { action: 'pass-through', target: target?.id ?? null });
            return false; // 不劫持按键
          }
          recordVoiceDebug('hotkey', { action: 'start', target: target.id });
          void controller.start(target);
          return true;
        },
      }), [controller]);

      // composer 锁定/提交时若正在录音则停止并冲刷
      React.useEffect(() => {
        if (locked && controller.getState().mode === 'recording' && controller.recordingTargetId === COMPOSER_TARGET_ID) {
          controller.stopExternal({ tail: 'flush' });
        }
      }, [locked, controller]);

      // 接管自停（D2）：仅当【主输入框】录音中且 composer seat 出现任一接管卡
      // （提问/审批/计划审阅）时自动停止并冲刷尾段；问题卡自身录音不能被此逻辑误停。
      React.useEffect(() => {
        if (state.mode !== 'recording') return undefined;
        const check = () => {
          if (controller.recordingTargetId !== COMPOSER_TARGET_ID) return; // 不是主输入框在录：不干预
          const seat = document.querySelector('[data-composer-seat]');
          if (seat === null) return;
          if (seat.querySelector('[data-question-key],[data-plan-review-key],[data-approval-key]') !== null) {
            controller.stopExternal({ tail: 'flush' });
          }
        };
        check();
        const timer = window.setInterval(check, 400);
        return () => window.clearInterval(timer);
      }, [state.mode, controller]);

      // 编辑自停守卫（E1 容器级委托；armed 条件实时求值）
      React.useEffect(() => {
        const el = btnRef.current;
        const container = el !== null && typeof el.closest === 'function' ? el.closest('[data-composer-card]') : null;
        return attachManualEditGuard({
          container,
          armed: () =>
            autoStopRef.current === true &&
            controller.getState().mode === 'recording' &&
            controller.recordingTargetId === COMPOSER_TARGET_ID,
          onEdit: () => controller.stopForManualEdit(),
        });
      }, [controller]);

      // IME 组合期跟踪（任务 9.3）：组合中写入延后到组合结束（有界 1s）。
      React.useEffect(() => {
        const el = btnRef.current;
        const card = el !== null && typeof el.closest === 'function' ? el.closest('[data-composer-card]') : null;
        if (card === null) return undefined;
        const onStart = () => targetRef.current.setComposing(true);
        const onEnd = () => targetRef.current.setComposing(false);
        card.addEventListener('compositionstart', onStart, true);
        card.addEventListener('compositionend', onEnd, true);
        return () => {
          card.removeEventListener('compositionstart', onStart, true);
          card.removeEventListener('compositionend', onEnd, true);
          targetRef.current.setComposing(false);
        };
      }, []);

      // 发送手势即停（评审 D2 / design D8）：宿主在 Lexical 命令层 CRITICAL 优先级就对
      // Enter 调 preventDefault，因此不会产生 beforeinput —— manual-edit.js 的 inputType
      // 分类器在结构上观测不到它，必须单独在 keydown 处观测。
      // **不共用** beforeinput 守卫的 armed 谓词（那个谓词首行是 autoStopRef.current === true）：
      // 发送手势与"键盘输入自动关闭麦克风"开关无关，开关关闭的边说边打用户最容易踩到
      // "消息已发出、麦克风仍在录、迟到文本落进新建空草稿"。
      // **不得**把 insertLineBreak 加进 CONTENT_EDIT_INPUT_TYPES：Shift+Enter 的 inputType
      // 正是它，加进去会直接违反"换行不触发停止"。
      React.useEffect(() => {
        const el = btnRef.current;
        const card = el !== null && typeof el.closest === 'function' ? el.closest('[data-composer-card]') : null;
        if (card === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Enter') return;
          if (event.shiftKey) return;                              // Shift+Enter = 换行，不停
          if (event.isComposing === true || event.keyCode === 229) return; // IME 组合中
          if (controller.getState().mode !== 'recording') return;
          if (controller.recordingTargetId !== COMPOSER_TARGET_ID) return;
          if (!composerWritable()) return;                         // 宿主未把它当发送 → 不停
          controller.stopExternal({ tail: 'discard' });            // 编辑停语义：丢弃未定稿尾段
        };
        card.addEventListener('keydown', onKeyDown, true); // 捕获阶段，先于宿主命令层
        return () => card.removeEventListener('keydown', onKeyDown, true);
      }, [controller, composerWritable]);

      // 菜单外点/Esc 关闭；Esc 分层（评审 D4）：捕获态优先取消捕获、菜单保持打开
      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const onDocDown = (event) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setMenuOpen(false);
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (captureRef.current) { setCapturing(false); return; } // 只取消捕获
          setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDocDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [menuOpen]);

      // 捕获态：按键由捕获控件消费（全局监听已因 active=false 挂起）；Esc 取消。
      React.useEffect(() => {
        if (!capturing) return undefined;
        const onCapture = (event) => {
          const result = captureHotkey(event);
          if (result.status === 'ignore') return; // 纯修饰键/重复/组合中：继续等待
          event.preventDefault();
          event.stopPropagation();
          if (result.status === 'cancelled') { setCapturing(false); setHotkeyNote(''); return; }
          if (result.status === 'rejected') { setHotkeyNote(result.message); return; }
          recordVoiceDebug('hotkey-bind', { hotkey: result.hotkey, warning: result.warning ?? null });
          setHotkey(writeHotkeyPref(result.hotkey));
          setHotkeyNote(result.warning ?? '');
          setCapturing(false);
        };
        document.addEventListener('keydown', onCapture, true);
        return () => document.removeEventListener('keydown', onCapture, true);
      }, [capturing]);

      // 菜单关闭即退出捕获态，避免全局快捷键被永久挂起。
      React.useEffect(() => {
        if (!menuOpen) { setCapturing(false); setHotkeyNote(''); }
      }, [menuOpen]);

      // 只读审计钩子（任务 9.4）：debug 开启时记录"可能是快捷键"的原始 keydown，
      // 用于分辨"按键根本没到页面（被系统/输入法吞）"与"到了但未命中绑定"。
      // 默认关闭时 recordVoiceDebug 是空操作，开销可忽略。
      React.useEffect(() => {
        const onAudit = (event) => {
          if (event.key === 'Escape') return;
          if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
          const active = document.activeElement;
          recordVoiceDebug('keydown', {
            key: event.key,
            code: event.code,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
            repeat: event.repeat === true,
            composing: event.isComposing === true,
            keyCode: event.keyCode,
            bound: hotkeyRef.current,
            active: active === null ? null : `${active.tagName}${active.className ? `.${String(active.className).slice(0, 60)}` : ''}`,
          });
        };
        document.addEventListener('keydown', onAudit, true);
        return () => document.removeEventListener('keydown', onAudit, true);
      }, []);

      const { mode, err, downloading } = state;
      const title = micTitle(mode, err, downloading, state.starting);
      // 与快捷键共用同一份可用性判定（评审 D3）。
      const disabled = mode === 'recording' ? false : !composerCanStart();

      const button = h('button', {
        ref: btnRef,
        type: 'button',
        className: 'dsv-local-button',
        title,
        'aria-label': title,
        'data-recording': mode === 'recording',
        disabled,
        onClick: () => {
          const live = controller.getState(); // 实时状态，避免 React 快照滞后（启动取消语义依赖）
          if (live.mode === 'idle') {
            if (live.starting) void controller.stop({ tail: 'flush' }); // 启动未完成：点击=取消
            else void controller.start(targetRef.current);
          } else if (live.mode === 'recording') {
            void controller.stop({ tail: 'flush' });
          }
        },
      }, mode === 'recording'
        ? h('span', { className: 'dsv-local-rec', 'aria-hidden': true })
        : mode === 'transcribing'
          ? h('span', { className: 'dsv-local-spinner', 'aria-hidden': true })
          : h(MicGlyph));

      const more = h('button', {
        type: 'button',
        className: 'dsv-local-ellipsis',
        title: '语音设置',
        'aria-label': '语音设置',
        'aria-expanded': menuOpen,
        disabled,
        onClick: (event) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        },
      }, h(EllipsisGlyph));

      const menu = menuOpen
        ? h('div', { className: 'dsv-local-menu' },
          h('div', { className: 'dsv-local-menu-desc' }, '语音输入（本地转写，音频不出本机）'),
          h('label', { className: 'dsv-local-menu-row' },
            h('input', {
              type: 'checkbox',
              checked: autoStop,
              onChange: (event) => {
                const next = event.target.checked === true;
                setAutoStop(next);
                writeAutoStopPref(next);
              },
            }),
            '键盘输入自动关闭麦克风'),
          h('div', { className: 'dsv-local-menu-row dsv-local-menu-hotkey' },
            h('span', null, '快捷键'),
            h('button', {
              type: 'button',
              className: 'dsv-local-hotkey-chip',
              'data-capturing': capturing ? 'true' : 'false',
              title: '点击后按下新的组合键',
              onClick: () => { setCapturing(true); setHotkeyNote(''); },
            }, capturing ? '请按下快捷键…' : formatHotkey(hotkey)),
            h('button', {
              type: 'button',
              className: 'dsv-local-hotkey-clear',
              title: '恢复默认快捷键',
              'aria-label': '恢复默认快捷键',
              onClick: () => {
                setCapturing(false);
                setHotkey(writeHotkeyPref(DEFAULT_HOTKEY));
                setHotkeyNote('');
              },
            }, '✕')),
          hotkeyNote !== '' ? h('div', { className: 'dsv-local-hotkey-hint' }, hotkeyNote) : null)
        : null;

      return h('span', { className: 'dsv-local-wrap', ref: wrapRef }, button, more, menu);
    }

    // ---------- apply ----------
    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const conversation = ctx.get('conversation');

      // 预热共享控制器（绑定本窗口的 toast）
      const controller = getSharedController();

      // 问题卡语音入口（fail-open：任何异常只降级，不影响宿主卡片）
      try {
        createQuestionInjector({ controller }).start();
      } catch (cause) {
        console.warn('[dsh-voice-local] question injector failed:', cause);
      }

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
