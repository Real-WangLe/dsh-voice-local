/**
 * DictationController 语义单元测试（design.md D10 停止矩阵 / D1 并发切换 / D3 busy 禁写即弃 / E2 liveness）。
 * 控制器是框架无关的：直接实例化，配 jsdom + 假音频栈驱动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDictationController } from '../../lib/dictation.js';

/** 构造浏览器假环境与控制器。transcribeTexts / transcribeReplies 按转写调用序依次返回。 */
function makeEnv({
  transcribeTexts = ['识别文本'],
  transcribeReplies = null,
  statusExtra = {},
  downloadError = null,
  controllerOptions = {},
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const win = dom.window;
  global.window = win;
  global.document = win.document;
  Object.defineProperty(global, 'navigator', { value: win.navigator, configurable: true });

  let call = 0;
  let downloadCalls = 0;
  const replies = transcribeReplies !== null
    ? [...transcribeReplies]
    : transcribeTexts.map((text) => ({ text }));
  const transcribeCalls = [];
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/model/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ready: true, download: { status: 'ready' }, ...statusExtra }),
      };
    }
    if (u.endsWith('/model/download')) {
      downloadCalls += 1;
      if (downloadError !== null) throw downloadError;
      return { ok: true, status: 202, json: async () => ({ ok: true, started: true }) };
    }
    if (u.endsWith('/transcribe')) {
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      transcribeCalls.push(reply.text);
      const body = { ok: true, text: reply.text };
      if (reply.gateReason !== undefined) body.gateReason = reply.gateReason;
      return { ok: true, status: 200, json: async () => body };
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
    const base = {
      id: overrides.id ?? 't',
      live: overrides.live ?? (() => true),
      acceptsWrites: overrides.acceptsWrites ?? (() => true),
      warn: overrides.warn ?? (() => {}),
      read: overrides.read ?? (() => ''),
      compose: overrides.compose ?? ((t) => t),
      write: overrides.write ?? (() => {}),
    };
    if (overrides.isComposing !== undefined) base.isComposing = overrides.isComposing;
    return base;
  }

  const notifications = [];
  const controller = createDictationController({
    notify: (message, kind) => notifications.push({ message, kind }),
    ...controllerOptions,
  });

  async function settle(ms = 30) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    controller, speakSegment, pushVoice, settle, target, transcribeCalls, notifications,
    downloadCalls: () => downloadCalls,
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

test('OV-4 守门判空可见：连续 2 段判空给一次可读提示，同一会话节流', async () => {
  const env = makeEnv({
    transcribeReplies: [
      { text: '', gateReason: 'no-speech' },
      { text: '', gateReason: 'below-min-speech' },
      { text: '', gateReason: 'no-speech' },
    ],
  });
  try {
    const hint = () => env.notifications.filter((n) => /没检测到人声/.test(n.message)).length;
    await env.controller.start(env.target({ id: 'composer' }));
    env.speakSegment();
    await env.settle();
    assert.equal(hint(), 0, '第 1 段判空不应立即提示');
    env.speakSegment();
    await env.settle();
    assert.equal(hint(), 1, '连续第 2 段判空应给出一次可读提示');
    env.speakSegment();
    await env.settle();
    assert.equal(hint(), 1, '同一会话内节流，只提示一次');
  } finally {
    env.cleanup();
  }
});

test('OV-4 判空计数的连续性：中途有正常结果则重新计数', async () => {
  const env = makeEnv({
    transcribeReplies: [
      { text: '', gateReason: 'no-speech' },
      { text: '正常一句' },
      { text: '', gateReason: 'no-speech' },
    ],
  });
  try {
    const hint = () => env.notifications.filter((n) => /没检测到人声/.test(n.message)).length;
    await env.controller.start(env.target({ id: 'composer' }));
    env.speakSegment(); // 判空 → streak 1
    await env.settle();
    env.speakSegment(); // 正常 → streak 归零
    await env.settle();
    env.speakSegment(); // 判空 → streak 1（未达 2）
    await env.settle();
    assert.equal(hint(), 0, '中间出现正常结果后不应累积到 2 段');
  } finally {
    env.cleanup();
  }
});

test('D3c 存量补齐：过滤器资产缺失/0 字节时触发一次补下载，齐备时不触发', async () => {
  const missing = makeEnv({
    statusExtra: { filters: { vad: { bytes: 0, ready: false }, denoiser: { bytes: 535638, ready: true } } },
  });
  try {
    await missing.controller.start(missing.target({ id: 'composer' }));
    await missing.settle();
    assert.equal(missing.downloadCalls(), 1, '存在 0 字节资产应触发补下载');
    assert.equal(missing.isRecording(), true, '补下载不得阻塞录音');
  } finally {
    missing.cleanup();
  }

  const complete = makeEnv({
    statusExtra: { filters: { vad: { bytes: 643854, ready: true }, denoiser: { bytes: 535638, ready: true } } },
  });
  try {
    await complete.controller.start(complete.target({ id: 'composer' }));
    await complete.settle();
    assert.equal(complete.downloadCalls(), 0, '资产齐备时不应触发补下载');
  } finally {
    complete.cleanup();
  }
});

test('D3c 补下载失败不影响录音主链路（fire-and-forget）', async () => {
  const env = makeEnv({
    statusExtra: { filters: { vad: { bytes: 0, ready: false }, denoiser: { bytes: 0, ready: false } } },
    downloadError: new Error('network down'),
  });
  try {
    await env.controller.start(env.target({ id: 'composer' }));
    await env.settle();
    assert.equal(env.downloadCalls(), 1);
    assert.equal(env.isRecording(), true, '补下载抛错不得阻止录音');
  } finally {
    env.cleanup();
  }
});

test('9.3 IME 组合期写入延后到组合结束（有界）', async () => {
  const env = makeEnv({ transcribeTexts: ['延迟写入'], controllerOptions: { compositionTimeoutMs: 500, compositionPollMs: 10 } });
  try {
    let composing = true;
    const written = [];
    const ta = env.target({ id: 'q1', isComposing: () => composing, write: (v) => written.push(v) });
    await env.controller.start(ta);
    env.speakSegment(); // 段落入队并完成转写
    await env.settle(40);
    assert.deepEqual(written, [], '组合期间不得写入');
    composing = false; // 组合结束
    await env.settle(80);
    assert.deepEqual(written, ['延迟写入'], '组合结束后写入该段');
  } finally {
    env.cleanup();
  }
});

test('9.3 组合期超时（上限 1s）则丢弃该段', async () => {
  const env = makeEnv({ transcribeTexts: ['不该出现'], controllerOptions: { compositionTimeoutMs: 60, compositionPollMs: 10 } });
  try {
    const written = [];
    const ta = env.target({ id: 'q2', isComposing: () => true, write: (v) => written.push(v) });
    await env.controller.start(ta);
    env.speakSegment();
    await env.settle(160);
    assert.deepEqual(written, [], '组合一直不结束 → 有界延后超时后丢弃');
  } finally {
    env.cleanup();
  }
});

test('9.3 延后期间目标进入不可写的提交事务状态则丢弃', async () => {
  const env = makeEnv({ transcribeTexts: ['不该出现'], controllerOptions: { compositionTimeoutMs: 500, compositionPollMs: 10 } });
  try {
    let composing = true;
    let writable = true;
    const written = [];
    const ta = env.target({
      id: 'q3',
      isComposing: () => composing,
      acceptsWrites: () => writable,
      write: (v) => written.push(v),
    });
    await env.controller.start(ta);
    env.speakSegment();
    await env.settle(40);
    assert.deepEqual(written, []);
    writable = false; // 提交事务：不可写
    await env.settle(80);
    assert.deepEqual(written, [], '延后期间进入提交事务状态应丢弃该段');
  } finally {
    env.cleanup();
  }
});

test('6.1/6.4 resolveTarget 三分支：提问卡 / 主输入框（含无焦点）/ 未知控件返回 null', () => {
  const env = makeEnv();
  try {
    const doc = window.document;
    const card = doc.createElement('div');
    card.setAttribute('data-composer-card', '');
    doc.body.appendChild(card);
    const composerTarget = env.target({ id: 'composer' });
    env.controller.registerTarget({ id: 'composer', target: composerTarget, isComposer: true, canStart: () => true });

    const questionTa = doc.createElement('textarea');
    doc.body.appendChild(questionTa);
    const questionTarget = env.target({ id: 'question:q1' });
    env.controller.registerTarget({
      id: 'question:q1',
      target: questionTarget,
      element: () => questionTa,
      canStart: () => true,
    });

    // 分支 1：焦点在已注册的提问卡回答框 → 该卡
    questionTa.focus();
    assert.equal(env.controller.resolveTarget(), questionTarget);

    // 分支 2a：焦点在主输入框子树内 → 主输入框
    card.setAttribute('tabindex', '-1');
    card.focus();
    assert.equal(env.controller.resolveTarget(), composerTarget);

    // 分支 2b：页面无焦点（activeElement 为 body）→ 主输入框
    card.blur();
    assert.equal(doc.activeElement, doc.body);
    assert.equal(env.controller.resolveTarget(), composerTarget);

    // 分支 3：焦点在未知可编辑控件（设置页搜索框等）→ null，不劫持
    const other = doc.createElement('input');
    doc.body.appendChild(other);
    other.focus();
    assert.equal(env.controller.resolveTarget(), null);

    // 注销后不再命中（白名单语义）
    env.controller.unregisterTarget('question:q1');
    questionTa.focus();
    assert.equal(env.controller.resolveTarget(), null);

    // canStartTarget 读的是注册项 canStart（可用性判定单一真源）
    assert.equal(env.controller.canStartTarget(composerTarget), true);
    env.controller.registerTarget({ id: 'composer', target: composerTarget, isComposer: true, canStart: () => false });
    assert.equal(env.controller.canStartTarget(composerTarget), false);
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
