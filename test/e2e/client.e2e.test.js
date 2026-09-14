import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React from 'react';
import ReactDOMClient from 'react-dom/client';
const { createRoot } = ReactDOMClient;
import { act } from 'react';

let dom;
let container;
let composerCard;
let root;
let loadedModule;
let slotDesc;
let slotComponent;
let fakeNode;
let draft = '';
let phase = 'plain';
let modelReady = true;
let transcribeText = '识别文本';
let transcribeError = null;
let micError = null;
let getUserMediaGate = null;
let audioWorkletError = null;
let modelDownloadError = false;
let modelDownloadStatus = 'downloading';
let streamStopped = false;
let submitCalls = 0;
const listeners = new Set();

function setSnapshot(next) {
  draft = next.draft ?? draft;
  phase = next.phase ?? phase;
  for (const listener of listeners) listener();
}

function useInput(selector) {
  const [value, setValue] = React.useState(() => selector({ draft, phase }));
  React.useEffect(() => {
    const listener = () => setValue(selector({ draft, phase }));
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [selector]);
  return value;
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

function setup({ autoStopOff = false } = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  });
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  dom.window.requestAnimationFrame = raf;
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  global.requestAnimationFrame = raf;
  global.URL = dom.window.URL;
  global.Blob = dom.window.Blob;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/model/status')) {
      return jsonResponse({ ok: true, ready: modelReady, download: { status: modelReady ? 'ready' : modelDownloadStatus } });
    }
    if (u.endsWith('/model/download')) {
      if (modelDownloadError) {
        return jsonResponse({ ok: false, error: { message: 'download start failed' } }, 500);
      }
      return jsonResponse({ ok: true, started: true, download: { status: 'downloading' } }, 202);
    }
    if (u.endsWith('/transcribe')) {
      if (transcribeError !== null) {
        return jsonResponse({ ok: false, error: { message: transcribeError } }, 500);
      }
      return jsonResponse({ ok: true, text: transcribeText });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  dom.window.fetch = global.fetch;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', {
    value: {
      getUserMedia: async () => {
        if (micError !== null) throw micError;
        if (getUserMediaGate !== null) await getUserMediaGate.promise;
        return { getTracks: () => [{ stop() { streamStopped = true; } }] };
      },
    },
    configurable: true,
  });

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  FakeAudioContext.prototype.audioWorklet = {
    addModule: async () => {
      if (audioWorkletError !== null) throw audioWorkletError;
    },
  };
  dom.window.AudioContext = FakeAudioContext;

  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
      fakeNode = this;
    }
    connect() {}
    disconnect() {}
  }
  dom.window.AudioWorkletNode = FakeAudioWorkletNode;
  dom.window.URL.createObjectURL = () => 'blob:fake-worklet';
  dom.window.URL.revokeObjectURL = () => {};

  loadedModule = null;
  dom.window.__ModuleLoader__ = { load: (mod) => { loadedModule = mod; } };
  const source = readFileSync(new URL('../../dist/client.js', import.meta.url), 'utf8');
  dom.window.eval(source);

  const factory = loadedModule.factory;
  const api = factory((id) => (id === 'react' ? React : undefined));

  let registerFn;
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { scope: (id) => ({ id }) };
      }
      if (name === 'conversation') {
        return {
          input: {
            for: () => ({
              state: { getSnapshot: () => ({ draft, phase }) },
            }),
          },
        };
      }
      return undefined;
    },
    inject(deps, cb) {
      cb({
        slots: {
          inject(name, fn) { registerFn = fn; },
          register(desc, Component) {
            slotDesc = desc;
            slotComponent = Component;
          },
        },
      });
    },
  };
  api.apply(ctx);
  registerFn(); // triggers scope.slots.register and captures desc/component
  const injectProps = slotDesc.inject('session-1');

  container = dom.window.document.getElementById('root');
  // 忠实还原宿主结构：麦克风控件挂在 [data-composer-card] 内（快捷键目标解析/发送手势依赖它）
  composerCard = dom.window.document.createElement('div');
  composerCard.setAttribute('data-composer-card', '');
  container.appendChild(composerCard);
  if (autoStopOff) dom.window.localStorage.setItem('dsh-voice-local:autoStopOnType', '0');
  mountComponent();
}

/** 挂载 MicButton（remount 复用同一 slotComponent）。 */
function mountComponent() {
  root = createRoot(composerCard);
  act(() => {
    root.render(React.createElement(slotComponent, {
      inputActions: {
        setDraft: (next) => setSnapshot({ draft: next, phase }),
        submit: () => { submitCalls += 1; }, // 断言程序化写入从不触发发送（9.2）
      },
      useInput,
      readDraft: slotDesc.inject('session-1').readDraft,
    }));
  });
}

/** 卸载后重新挂载（用于验证偏好持久化后重新挂载仍生效）。 */
function remount() {
  act(() => root.unmount());
  mountComponent();
}

function teardown() {
  if (root !== undefined) {
    act(() => root.unmount());
  }
  if (dom !== undefined) dom.window.close();
  root = undefined;
  dom = undefined;
  container = undefined;
  composerCard = undefined;
  slotDesc = undefined;
  slotComponent = undefined;
  fakeNode = undefined;
  draft = '';
  phase = 'plain';
  modelReady = true;
  transcribeText = '识别文本';
  transcribeError = null;
  micError = null;
  getUserMediaGate = null;
  audioWorkletError = null;
  modelDownloadError = false;
  modelDownloadStatus = 'downloading';
  streamStopped = false;
  submitCalls = 0;
  listeners.clear();
}

async function clickButton() {
  const btn = container.querySelector('button');
  await act(async () => {
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test('client registers conversation.input.left slot', () => {
  setup();
  try {
    assert.equal(slotDesc.name, 'conversation.input.left');
    assert.equal(slotDesc.id, 'dsh-voice-local-button');
    assert.equal(typeof slotComponent, 'function');
  } finally {
    teardown();
  }
});

test('click starts recording and silence segment appends transcribed text', async () => {
  setup();
  try {
    transcribeText = '你好世界';
    await clickButton();
    let btn = container.querySelector('button');
    assert.equal(btn.dataset.recording, 'true');

    // 模拟 500ms 语音（≥ 最短人声门 minSpeechMs=300ms）+ 足够静音触发自动断句
    for (let i = 0; i < 5; i += 1) {
      fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    }
    for (let i = 0; i < 8; i += 1) {
      fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
    }
    await flush();
    assert.equal(draft, '你好世界');
  } finally {
    teardown();
  }
});

test('stop flushes remaining audio and appends final text', async () => {
  setup();
  try {
    transcribeText = '最后一段';
    await clickButton();
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    await flush();
    await clickButton(); // stop
    assert.equal(draft, '最后一段');
  } finally {
    teardown();
  }
});

test('microphone permission error shows readable error', async () => {
  setup();
  try {
    micError = new Error('Permission denied');
    await clickButton();
    const btn = container.querySelector('button');
    assert.match(btn.title, /Permission denied/);
  } finally {
    teardown();
  }
});

test('transcription failure shows toast and does not crash', async () => {
  setup();
  try {
    transcribeError = 'boom';
    await clickButton();
    // ≥ 最短人声门（300ms）的语音，确保段落会上传并触发失败提示
    for (let i = 0; i < 5; i += 1) {
      fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    }
    for (let i = 0; i < 8; i += 1) {
      fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
    }
    await flush();
    const toasts = [...dom.window.document.querySelectorAll('.dsv-local-toast')];
    assert.ok(toasts.some((t) => t.textContent.includes('boom')));
  } finally {
    teardown();
  }
});

test('rapid stop during start cancels pending recording', async () => {
  setup();
  try {
    let resolveGetUserMedia;
    getUserMediaGate = { promise: new Promise((resolve) => { resolveGetUserMedia = resolve; }) };
    await clickButton(); // start 在 getUserMedia 挂起
    await clickButton(); // stop 应取消这次启动
    resolveGetUserMedia();
    await flush();
    const btn = container.querySelector('button');
    assert.equal(btn.dataset.recording, 'false');
    assert.equal(fakeNode, undefined);
  } finally {
    teardown();
  }
});

test('model downloading disables mic button', async () => {
  setup();
  try {
    modelReady = false;
    await clickButton();
    const btn = container.querySelector('button');
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /模型下载中/);
  } finally {
    teardown();
  }
});

test('audio worklet failure stops mic stream', async () => {
  setup();
  try {
    audioWorkletError = new Error('addModule failed');
    await clickButton();
    await flush();
    const btn = container.querySelector('button');
    assert.equal(btn.dataset.recording, 'false');
    assert.equal(streamStopped, true);
  } finally {
    teardown();
  }
});

test('download start failure does not leave button disabled', async () => {
  setup();
  try {
    modelReady = false;
    modelDownloadStatus = 'idle';
    modelDownloadError = true;
    await clickButton();
    await flush();
    const btn = container.querySelector('button');
    assert.equal(btn.disabled, false);
    assert.doesNotMatch(btn.title, /模型下载中/);
  } finally {
    teardown();
  }
});

// ---------- 问题卡语音入口（add-voice-autostop-and-question-mic） ----------

/** 在 body 下构建一张提问卡（inline 形态：选项行 + 自定义回答行）。 */
function buildQuestionCard(key, { withOptions = true } = {}) {
  const frame = document.createElement('div');
  frame.setAttribute('data-question-key', key);
  const options = document.createElement('div');
  const row = document.createElement('div'); // customRow（inline）或容器（block）
  if (withOptions) {
    const checkbox = document.createElement('span'); // 行首编号/勾选框
    row.appendChild(checkbox);
  }
  const field = document.createElement('div');
  const ta = document.createElement('textarea');
  ta.disabled = false;
  field.appendChild(ta);
  row.appendChild(field);
  options.appendChild(row);
  frame.appendChild(options);
  document.body.appendChild(frame);
  return { frame, ta };
}

async function waitFor(predicate, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function clickElement(el) {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** 触发文档级快捷键（默认 Ctrl+Alt+V）。 */
async function pressHotkey(init = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'v',
    code: 'KeyV',
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    document.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return event;
}

/** 推一段满足最短人声门的语音 + 静音，触发自动断句。 */
function speakSegment() {
  for (let i = 0; i < 5; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
  for (let i = 0; i < 8; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
}

test('question card gets mic injected in both inline and block forms', async () => {
  setup();
  try {
    const inlineCard = buildQuestionCard('q-inline', { withOptions: true });
    const blockCard = buildQuestionCard('q-block', { withOptions: false });
    const ok = await waitFor(() =>
      inlineCard.frame.querySelector('.dsv-local-button') !== null
      && blockCard.frame.querySelector('.dsv-local-button') !== null);
    assert.ok(ok, '两种形态都应注入麦克风按钮');
  } finally {
    teardown();
  }
});

test('question card voice write updates field and dispatches bubbling input event', async () => {
  setup();
  try {
    transcribeText = '语音回答';
    let submitted = false;
    const { frame, ta } = buildQuestionCard('q-write');
    // 监听写入派发的事件（宿主 React 受控组件依赖冒泡的 input 事件）
    const dispatched = [];
    const origDispatch = ta.dispatchEvent.bind(ta);
    ta.dispatchEvent = (ev) => { dispatched.push(ev); return origDispatch(ev); };

    const injected = await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    assert.ok(injected, '自定义回答行应注入麦克风按钮');
    await clickElement(frame.querySelector('.dsv-local-button'));
    for (let i = 0; i < 5; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    for (let i = 0; i < 8; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
    await flush();

    assert.equal(ta.value, '语音回答', '识别文本应经受控写入通道落到输入框');
    const inputEv = dispatched.find((e) => e.type === 'input');
    assert.ok(inputEv !== undefined, '应向宿主派发 input 事件');
    assert.equal(inputEv.bubbles, true, 'input 事件必须冒泡才能被宿主根容器委托捕获');
    assert.equal(submitted, false);
  } finally {
    teardown();
  }
});

test('busy (disabled) answer discards incoming segment and stops recording', async () => {
  setup();
  try {
    transcribeText = '迟到的话';
    const { frame, ta } = buildQuestionCard('q-busy');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    const btn = frame.querySelector('.dsv-local-button');
    await clickElement(btn);
    assert.equal(btn.dataset.recording, 'true');
    // 宿主进入提交中：禁用回答框
    ta.disabled = true;
    // 推一段已断句语音 → 写入应被拒并停录
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    for (let i = 0; i < 8; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
    const stopped = await waitFor(() => btn.dataset.recording === 'false');
    assert.ok(stopped, 'busy 应触发停录');
    await flush();
    assert.equal(ta.value, '', 'busy 目标不得被写入');
  } finally {
    teardown();
  }
});

test('pager flip rebuilds entry and drops tail (no cross-question carryover)', async () => {
  setup();
  try {
    transcribeText = '旧题尾段';
    const { frame, ta } = buildQuestionCard('q-pager');
    // 模拟宿主分页进度：初始第 1 题
    const progress = document.createElement('span');
    progress.textContent = '1 / 2';
    frame.appendChild(progress);
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    const btn = frame.querySelector('.dsv-local-button');
    await clickElement(btn);
    // 翻页：宿主替换 textarea 节点并把页码变为第 2 题
    const newTa = document.createElement('textarea');
    progress.textContent = '2 / 2';
    ta.replaceWith(newTa);
    const rebuilt = await waitFor(() => {
      const b = frame.querySelector('.dsv-local-button');
      return b !== null && b.dataset.recording === 'false';
    });
    assert.ok(rebuilt, '翻页后应停止录音并重建入口');
    await flush();
    assert.equal(newTa.value, '', '未定稿尾段不跨题残留');
    const ctrl = window.__dshVoiceLocalDictation__;
    assert.equal(ctrl.getState().mode, 'idle');
  } finally {
    teardown();
  }
});

test('card removal cleans up injection completely', async () => {
  setup();
  try {
    const { frame } = buildQuestionCard('q-gone');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    frame.remove();
    const gone = await waitFor(() => document.querySelector('[data-question-key] .dsv-local-button') === null);
    assert.ok(gone, '卡片消失后按钮应被移除');
  } finally {
    teardown();
  }
});

test('takeover card auto-stops composer recording with tail flush', async () => {
  setup();
  try {
    transcribeText = '隐形尾段';
    // 主输入框开始录音
    await clickButton();
    assert.equal(container.querySelector('button').dataset.recording, 'true');
    // 说半段（未定稿）
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    // 接管卡弹出（审批）
    const seat = document.createElement('div');
    seat.setAttribute('data-composer-seat', '');
    const approval = document.createElement('div');
    approval.setAttribute('data-approval-key', 'ap1');
    seat.appendChild(approval);
    document.body.appendChild(seat);
    // 观察器轮询 400ms 内应自停并冲刷尾段到草稿
    const stopped = await waitFor(() => container.querySelector('button').dataset.recording === 'false', 1500);
    assert.ok(stopped, '接管弹出应自动停止主输入框录音');
    await flush();
    assert.equal(draft, '隐形尾段', '接管停的尾段应冲刷落草稿');
  } finally {
    teardown();
  }
});

test('model download flow works from question card entry', async () => {
  setup();
  try {
    modelReady = false;
    const { frame } = buildQuestionCard('q-model');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    const btn = frame.querySelector('.dsv-local-button');
    await clickElement(btn);
    const downloading = await waitFor(() => btn.disabled === true && /模型下载中/.test(btn.title));
    assert.ok(downloading, '卡片入口应复用模型下载路径');
  } finally {
    teardown();
  }
});

test('ellipsis menu toggles autostop preference and closes on outside click', async () => {
  setup();
  try {
    const more = container.querySelector('.dsv-local-ellipsis');
    assert.ok(more !== null, '麦克风旁应有 ⋮ 配置按钮');
    await clickElement(more);
    let menu = container.querySelector('.dsv-local-menu');
    assert.ok(menu !== null, '点击 ⋮ 应打开菜单');
    const box = menu.querySelector('input[type=checkbox]');
    assert.ok(box !== null);
    assert.equal(box.checked, true, '默认开启自停');
    // 注意：jsdom+React18 委托限制下合成 change 不触发 React onChange；
    // 偏好读写本身已由 test/unit/manual-edit.test.js 覆盖。
    // 点外部关闭
    await act(async () => {
      document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    menu = container.querySelector('.dsv-local-menu');
    assert.equal(menu, null, '点击外部应关闭菜单');
  } finally {
    teardown();
  }
});

test('question card recording is not stopped by composer takeover watcher (regression)', async () => {
  setup();
  try {
    transcribeText = '问题卡语音';
    const { frame, ta } = buildQuestionCard('q-not-killed');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    const btn = frame.querySelector('.dsv-local-button');
    await clickElement(btn);
    assert.equal(btn.dataset.recording, 'true', '问题卡麦克风应进入录音态');
    // 等待超过接管监视器 400ms 间隔，确认不被误停
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(btn.dataset.recording, 'true', '主 composer 接管自停不得误停问题卡录音');
    // 说话断句 → 落进问题卡输入框（≥ 最短人声门 300ms）
    for (let i = 0; i < 5; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    for (let i = 0; i < 8; i += 1) fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0) });
    await flush();
    assert.equal(ta.value, '问题卡语音');
  } finally {
    teardown();
  }
});

// ---------- 快捷键 / 目标解析 / 发送手势 / 插入安全（add-voice-hotkey-and-fix-gating 第 6-9 节） ----------

test('hotkey starts and stops recording exactly like the mic button; programmatic write never submits', async () => {
  setup();
  try {
    transcribeText = '快捷键文本';
    const started = await pressHotkey();
    const btn = container.querySelector('button');
    assert.equal(btn.dataset.recording, 'true', '空闲时按快捷键应开始录音');
    assert.equal(started.defaultPrevented, true, '目标解析成功时应阻止按键默认行为');
    speakSegment();
    await flush();
    assert.equal(draft, '快捷键文本');
    assert.equal(submitCalls, 0, '程序化写入不得触发宿主发送/提交手势（9.2）');
    const stopped = await pressHotkey();
    assert.equal(btn.dataset.recording, 'false', '录音中按快捷键应停止并冲刷');
    assert.equal(stopped.defaultPrevented, true);
  } finally {
    teardown();
  }
});

test('hotkey semantics are identical with the autostop switch on and off (两种模式)', async () => {
  for (const autoStopOff of [false, true]) {
    setup({ autoStopOff });
    try {
      transcribeText = autoStopOff ? '关闭自停' : '开启自停';
      await pressHotkey();
      const btn = container.querySelector('button');
      assert.equal(btn.dataset.recording, 'true', `autoStopOff=${autoStopOff} 应开始`);
      speakSegment();
      await flush();
      assert.equal(draft, transcribeText, `autoStopOff=${autoStopOff} 应写入`);
      await pressHotkey();
      assert.equal(btn.dataset.recording, 'false', `autoStopOff=${autoStopOff} 应停止`);
    } finally {
      teardown();
    }
  }
});

test('hotkey resolves target by focus: question card / composer / unknown control', async () => {
  setup();
  try {
    // 1) 页面无焦点 → 主输入框
    let ev = await pressHotkey();
    assert.equal(container.querySelector('button').dataset.recording, 'true');
    assert.equal(ev.defaultPrevented, true);
    await clickButton(); // 停
    await flush();

    // 2) 焦点在提问卡回答框 → 录向该卡
    transcribeText = '录向提问卡';
    const { frame, ta } = buildQuestionCard('q-hotkey');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    ta.focus();
    ev = await pressHotkey();
    assert.equal(ev.defaultPrevented, true);
    speakSegment();
    await flush();
    assert.equal(ta.value, '录向提问卡', '识别文本应插入提问卡回答框');
    await clickElement(frame.querySelector('.dsv-local-button')); // 停提问卡录音
    await flush();

    // 3) 焦点在未知可编辑控件（设置页搜索框）→ 不触发、不阻止按键
    const search = document.createElement('input');
    document.body.appendChild(search);
    search.focus();
    ev = await pressHotkey();
    assert.equal(ev.defaultPrevented, false, '焦点在其他可编辑控件时不得劫持按键');
    assert.equal(container.querySelector('button').dataset.recording, 'false');
  } finally {
    teardown();
  }
});

test('hotkey does not start (no flash) when composer unavailable; the key is passed through', async () => {
  setup();
  try {
    // 1) 提问卡 disabled → 其注册目标不可开始录音（canStart 判定单一真源）。
    //    注意：本子例必须在 seat 出现之前跑——injector 一旦观测到 seat 就会把
    //    observer 切到 seat（既有 D6 行为），此后挂在 body 上的卡片不再被观测。
    const { ta } = buildQuestionCard('q-disabled');
    ta.disabled = true;
    await waitFor(() => document.querySelector('[data-question-key="q-disabled"] .dsv-local-button') !== null);
    const ctrl = window.__dshVoiceLocalDictation__;
    assert.equal(ctrl.canStartTarget({ id: 'question:q-disabled' }), false, 'disabled 提问卡不可开始录音');
    assert.equal(ctrl.getState().mode, 'idle');

    // 2) 接管卡片弹出：seat 内出现 [data-question-key] → 不启动、不阻止按键
    const seat = document.createElement('div');
    seat.setAttribute('data-composer-seat', '');
    const takeover = document.createElement('div');
    takeover.setAttribute('data-question-key', 'takeover');
    seat.appendChild(takeover);
    document.body.appendChild(seat);
    let ev = await pressHotkey();
    assert.equal(container.querySelector('button').dataset.recording, 'false', '接管卡片时不得启动（防闪一下）');
    assert.equal(ev.defaultPrevented, false, '不可用时不得阻止按键');
    seat.remove();

    // 3) 提交事务状态（phase !== plain）→ 同样不启动、不阻止按键
    await act(async () => { setSnapshot({ phase: 'review' }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    ev = await pressHotkey();
    assert.equal(container.querySelector('button').dataset.recording, 'false');
    assert.equal(ev.defaultPrevented, false);
    await act(async () => { setSnapshot({ phase: 'plain' }); await new Promise((resolve) => setTimeout(resolve, 10)); });
  } finally {
    teardown();
  }
});

test('menu hotkey row: rebind, persist, survive remount, clear restores default', async () => {
  setup();
  try {
    await clickElement(container.querySelector('.dsv-local-ellipsis'));
    let chip = container.querySelector('.dsv-local-hotkey-chip');
    assert.equal(chip.textContent, 'Ctrl+Alt+V', '默认显示平台键位');
    await clickElement(chip);
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, '请按下快捷键…');

    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    chip = container.querySelector('.dsv-local-hotkey-chip');
    assert.equal(chip.textContent, 'Ctrl+Alt+K', '按键即完成绑定');
    assert.equal(dom.window.localStorage.getItem('dsh-voice-local:hotkey'), 'Mod+Alt+K', '绑定应持久化');

    remount();
    await clickElement(container.querySelector('.dsv-local-ellipsis'));
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, 'Ctrl+Alt+K', '重新挂载后菜单显示新键位');

    await clickElement(container.querySelector('.dsv-local-hotkey-clear'));
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, 'Ctrl+Alt+V', '清除恢复默认');
    assert.equal(dom.window.localStorage.getItem('dsh-voice-local:hotkey'), 'Mod+Alt+V');
  } finally {
    teardown();
  }
});

test('capture rejects reserved combos and allows conflict combos with a readable hint', async () => {
  setup();
  try {
    await clickElement(container.querySelector('.dsv-local-ellipsis'));
    await clickElement(container.querySelector('.dsv-local-hotkey-chip'));

    // 浏览器保留键 Ctrl+W → 拒绝并说明
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.match(container.querySelector('.dsv-local-hotkey-hint').textContent, /保留/);
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, '请按下快捷键…', '拒绝后仍处于捕获态');

    // Ctrl+Space 冲突组合 → 允许绑定但提示
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, 'Ctrl+Space');
    assert.match(container.querySelector('.dsv-local-hotkey-hint').textContent, /输入法|操作系统/);
  } finally {
    teardown();
  }
});

test('capture state consumes the bound combo without toggling recording; Esc only cancels capture', async () => {
  setup();
  try {
    await clickElement(container.querySelector('.dsv-local-ellipsis'));
    await clickElement(container.querySelector('.dsv-local-hotkey-chip'));
    // 捕获态按下当前已绑组合
    await pressHotkey();
    assert.equal(container.querySelector('button').dataset.recording, 'false', '捕获态不得触发录音');
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, 'Ctrl+Alt+V', '组合被捕获控件消费并完成绑定');

    // 再次进入捕获态按 Esc → 只取消捕获，菜单保持打开
    await clickElement(container.querySelector('.dsv-local-hotkey-chip'));
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, '请按下快捷键…');
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.ok(container.querySelector('.dsv-local-menu') !== null, 'Esc 只取消捕获，⋮ 菜单保持打开');
    assert.equal(container.querySelector('.dsv-local-hotkey-chip').textContent, 'Ctrl+Alt+V');
    assert.equal(container.querySelector('button').dataset.recording, 'false');
  } finally {
    teardown();
  }
});

test('Enter send gesture stops recording and discards the tail, regardless of the autostop switch', async () => {
  for (const autoStopOff of [false, true]) {
    setup({ autoStopOff });
    try {
      transcribeText = '未定稿尾段';
      await clickButton();
      const btn = container.querySelector('button');
      assert.equal(btn.dataset.recording, 'true');
      fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) }); // 未定稿尾段
      const card = document.querySelector('[data-composer-card]');
      await act(async () => {
        card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.equal(btn.dataset.recording, 'false', `autoStopOff=${autoStopOff}：回车发送手势应停麦`);
      await flush();
      assert.equal(draft, '', '未定稿尾段应被丢弃，不落进发送后新建的空草稿');
    } finally {
      teardown();
    }
  }
});

test('Shift+Enter and question-card Enter do not stop recording (regression guard)', async () => {
  setup();
  try {
    await clickButton();
    const btn = container.querySelector('button');
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
    const card = document.querySelector('[data-composer-card]');
    await act(async () => {
      card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(btn.dataset.recording, 'true', 'Shift+Enter（换行）不得停麦');
    await clickButton(); // 手动停并冲刷尾段
    await flush();

    const { frame, ta } = buildQuestionCard('q-enter');
    await waitFor(() => frame.querySelector('.dsv-local-button') !== null);
    const qBtn = frame.querySelector('.dsv-local-button');
    await clickElement(qBtn);
    assert.equal(qBtn.dataset.recording, 'true');
    await act(async () => {
      ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(qBtn.dataset.recording, 'true', '提问卡回答框的回车是换行语义，不停录');
  } finally {
    teardown();
  }
});

test('composer write is deferred while IME composition is active (bounded), then flushed on compositionend', async () => {
  setup();
  try {
    transcribeText = '组合期文本';
    await clickButton();
    const card = document.querySelector('[data-composer-card]');
    await act(async () => {
      card.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    speakSegment();
    await flush();
    assert.equal(draft, '', '输入法组合期间写入应延后');
    await act(async () => {
      card.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    assert.equal(draft, '组合期文本', '组合结束后延后的写入应落草稿');
    assert.equal(submitCalls, 0, '延后写入同样不得触发发送');
  } finally {
    teardown();
  }
});

test('hotkey stops an in-progress recording regardless of focus (regression)', async () => {
  setup();
  try {
    await clickButton();
    const btn = container.querySelector('button');
    assert.equal(btn.dataset.recording, 'true');
    // 焦点移到与语音无关的控件（设置页搜索框那类）：停止不应依赖焦点
    const search = document.createElement('input');
    document.body.appendChild(search);
    search.focus();
    assert.equal(document.activeElement, search);
    const ev = await pressHotkey();
    assert.equal(btn.dataset.recording, 'false', '录音中按快捷键必须停止，与焦点无关');
    assert.equal(ev.defaultPrevented, true, '录音中停止也应消费该按键');
  } finally {
    teardown();
  }
});
