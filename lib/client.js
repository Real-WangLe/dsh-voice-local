/**
 * dsh-voice-local web 端（client 插件入口）：
 * 输入框工具行麦克风按钮（薄壳）→ 共享听写控制器（dictation.js）→
 * AudioWorklet 录音 → 浏览器静音检测分段 → 逐段转写 → 光标处写入输入目标。
 *
 * 提问卡片入口由 question-injector.js 注入，与本入口共享同一控制器。
 */
import { joinDraft, composeInsertion } from './pure.js';
import { createDictationController } from './dictation.js';
import { attachManualEditGuard, readAutoStopPref, writeAutoStopPref } from './manual-edit.js';
import { createQuestionInjector } from './question-injector.js';

window.__ModuleLoader__.load({
  id: 'dsh-voice-local',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const COMPOSER_TARGET_ID = 'composer';

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
      return {
        id: COMPOSER_TARGET_ID,
        live: () => true,
        acceptsWrites: () => true,
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

      // 菜单外点/Esc 关闭
      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const onDocDown = (event) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setMenuOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDocDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [menuOpen]);

      // 生命周期：卸载时释放目标（在录则静默停、不回填——v1 卸载语义）
      React.useEffect(() => () => {
        controller.releaseTarget(COMPOSER_TARGET_ID);
      }, [controller]);

      const { mode, err, downloading } = state;
      const title = micTitle(mode, err, downloading, state.starting);
      const disabled = mode === 'recording' ? false : (locked || mode === 'transcribing' || downloading);

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
            '键盘输入自动关闭麦克风'))
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
