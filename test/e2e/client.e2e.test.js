import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
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
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
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

    // 模拟 100ms 语音 + 足够静音触发自动断句
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
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
    fakeNode.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
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
