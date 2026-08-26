/**
 * DictationController 语义单元测试（design.md D10 停止矩阵 / D1 并发切换 / D3 busy 禁写即弃 / E2 liveness）。
 * 控制器是框架无关的：直接实例化，配 jsdom + 假音频栈驱动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDictationController } from '../../lib/dictation.js';

/** 构造浏览器假环境与控制器。transcribeTexts 按转写调用序依次返回。 */
function makeEnv({ transcribeTexts = ['识别文本'] } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const win = dom.window;
  global.window = win;
  global.document = win.document;
  Object.defineProperty(global, 'navigator', { value: win.navigator, configurable: true });

  let call = 0;
  const texts = [...transcribeTexts];
  const transcribeCalls = [];
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/model/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ready: true, download: { status: 'ready' } }) };
    }
    if (u.endsWith('/transcribe')) {
      const text = texts[Math.min(call, texts.length - 1)];
      call += 1;
      transcribeCalls.push(text);
      return { ok: true, status: 200, json: async () => ({ ok: true, text }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  let streamStopped = false;
  Object.defineProperty(win.navigator, 'mediaDevices', {
    value: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop() { streamStopped = true; } }],
      }),
    },
    configurable: true,
  });

  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  FakeAudioContext.prototype.audioWorklet = { addModule: async () => {} };
  win.AudioContext = FakeAudioContext;

  let node = null;
  win.AudioWorkletNode = class {
    constructor() { this.port = { onmessage: null }; node = this; }
    connect() {} disconnect() {}
  };
  win.URL.createObjectURL = () => 'blob:fake';
  win.URL.revokeObjectURL = () => {};

  /** 推一段语音（400ms，满足自适应门控最短人声时长）+ 若干静音帧以触发断句。 */
  function speakSegment() {
    pushVoice();
    pushVoice();
    pushVoice();
    pushVoice();
    for (let i = 0; i < 8; i += 1) node.port.onmessage({ data: new Float32Array(1600).fill(0) });
  }
  /** 只推语音帧：制造"未定稿尾段"。 */
  function pushVoice() {
    node.port.onmessage({ data: new Float32Array(1600).fill(0.5) });
  }

  function target(overrides = {}) {
    return {
      id: overrides.id ?? 't',
      live: overrides.live ?? (() => true),
      acceptsWrites: overrides.acceptsWrites ?? (() => true),
      warn: overrides.warn ?? (() => {}),
      read: overrides.read ?? (() => ''),
      compose: overrides.compose ?? ((t) => t),
      write: overrides.write ?? (() => {}),
    };
  }

  const controller = createDictationController({ notify: () => {} });

  async function settle(ms = 30) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    controller, speakSegment, pushVoice, settle, target, transcribeCalls,
    isRecording: () => controller.getState().mode === 'recording',
    cleanup: () => { controller.dispose(); dom.window.close(); delete global.window; delete global.document; },
    _streamStopped: () => streamStopped,
  };
}

test('D1 并发切换：新目标立即开录，旧目标尾段按序写入旧写入器', async () => {
  const env = makeEnv({ transcribeTexts: ['S1', 'S2', 'S3'] });
  try {
    const logA = [];
    const logB = [];
    const ta = env.target({ id: 'a', compose: (t) => `A:${t}`, write: (v) => logA.push(v) });
    const tb = env.target({ id: 'b', compose: (t) => `B:${t}`, write: (v) => logB.push(v) });

    await env.controller.start(ta);
    assert.ok(env.isRecording());

    // A 说一段并自动断句（入队 seg1=S1）
    env.speakSegment();
    // 再说半段（未定稿尾），随后切到 B —— 尾段应被冲刷入队为 S2
    env.pushVoice();
    await env.controller.start(tb); // 并发切换：此调用立即冲刷旧尾段并让 B 走完启动
    assert.equal(env.controller.recordingTargetId, 'b');
    env.speakSegment(); // B 说一段并自动断句（入队 S3）

    assert.ok(env.isRecording(), '切换后 B 应已在录音');
    assert.equal(env.controller.recordingTargetId, 'b');
    // 队列清空后：A 收到 seg1 与尾段（按序），互不干扰
    await env.controller.stop({ tail: 'flush' }); // 停 B 并冲刷
    await env.settle();
    assert.deepEqual(logA, ['A:S1', 'A:S2'], '旧目标按序收到已断句段与冲刷尾段');
    assert.deepEqual(logB, ['B:S3'], `ACTUAL logB=${JSON.stringify(logB)} logA=${JSON.stringify(logA)} calls=${JSON.stringify(env.transcribeCalls)} mode=${env.controller.getState().mode}`);
  } finally {
    env.cleanup();
  }
});

test('D10 编辑自停：丢弃未定稿尾段，不回填', async () => {
  const env = makeEnv({ transcribeTexts: ['识别文本'] });
  try {
    const written = [];
    const ta = env.target({ write: (v) => written.push(v) });
    await env.controller.start(ta);
    env.speakSegment(); // 已断句入队（已定稿段落正常落位）
    await env.settle();
    // 再说半段（只推语音、无静音 → 未定稿），然后编辑触发停
    env.pushVoice();
    await env.controller.stopForManualEdit();
    await env.settle();
    assert.equal(env.controller.getState().mode, 'idle');
    // 未定稿尾段被丢弃：只有第一次断句的文本落位
    assert.deepEqual(written, ['识别文本']);
  } finally {
    env.cleanup();
  }
});

test('D10 外部触发停（接管）：冲刷尾段落位', async () => {
  const env = makeEnv({ transcribeTexts: ['尾段'] });
  try {
    const written = [];
    const ta = env.target({ write: (v) => written.push(v) });
    await env.controller.start(ta);
    // 只推语音帧（未定稿），随后接管卡弹出式停止 → 尾段冲刷落位
    env.pushVoice();
    env.controller.stopExternal({ tail: 'flush' });
    await env.settle();
    assert.deepEqual(written, ['尾段']);
  } finally {
    env.cleanup();
  }
});

test('D3 busy 禁写即弃：acceptsWrites=false 时丢弃并警告', async () => {
  const env = makeEnv({ transcribeTexts: ['迟到的话'] });
  try {
    const warnings = [];
    const written = [];
    const ta = env.target({
      acceptsWrites: () => false,
      write: (v) => written.push(v),
      warn: (r) => warnings.push(r),
    });
    await env.controller.start(ta);
    env.speakSegment();
    await env.settle();
    assert.deepEqual(written, [], 'busy 目标不得被写入');
    assert.ok(warnings.includes('target-busy'));
  } finally {
    env.cleanup();
  }
});

test('E2 liveness：目标卸载后队列内写入静默丢弃', async () => {
  const env = makeEnv({ transcribeTexts: ['晚到的文本'] });
  try {
    let alive = true;
    const written = [];
    const ta = env.target({ live: () => alive, write: (v) => written.push(v) });
    await env.controller.start(ta);
    env.speakSegment(); // 入队（转写异步）
    alive = false;      // 模拟入口卸载/翻页移除
    await env.settle();
    assert.deepEqual(written, []);
  } finally {
    env.cleanup();
  }
});

test('releaseTarget：在录则静默停止且不回填（v1 卸载语义）', async () => {
  const env = makeEnv({ transcribeTexts: ['x'] });
  try {
    const written = [];
    const ta = env.target({ id: 'q1', write: (v) => written.push(v) });
    await env.controller.start(ta);
    assert.ok(env.isRecording());
    env.controller.releaseTarget('q1');
    await env.settle();
    assert.equal(env.controller.getState().mode, 'idle');
    assert.equal(env._streamStopped(), true);
  } finally {
    env.cleanup();
  }
});
