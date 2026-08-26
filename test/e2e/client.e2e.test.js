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

function setup() {
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
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(slotComponent, {
      inputActions: {
        setDraft: (next) => setSnapshot({ draft: next, phase }),
      },
      useInput,
      readDraft: injectProps.readDraft,
    }));
  });
}

function teardown() {
  if (root !== undefined) {
    act(() => root.unmount());
  }
  if (dom !== undefined) dom.window.close();
  root = undefined;
  dom = undefined;
  container = undefined;
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
