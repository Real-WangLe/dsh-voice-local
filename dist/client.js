/**
 * GENERATED FILE — do not edit.
 * Assembled by scripts/build.mjs from lib/{pure,manual-edit,hotkey,dictation,question-injector,client}.js
 */
// ===== fragment: pure.js =====
/**
 * dsh-voice-local 浏览器端纯函数：重采样、WAV 编码、RMS、草稿拼接、静音分段。
 * 独立成模块便于 Node 单元测试；浏览器 bundle 由 scripts/build.mjs 以 fragment
 * 拼接自动携带本文件（保持纯函数，勿引入 Node 专属 API）。
 */

const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORD_MS = 60_000;

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

/** 线性插值重采样（仅当浏览器实际采样率 ≠ 16k 时使用）。 */
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

/** Float32 PCM → PCM16 mono WAV（Uint8Array）。 */
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

/** 计算一段 PCM 的 RMS（0..1）。 */
function computeRms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * 草稿追加：英文/数字边界插入空格，避免粘连。
 * @param {string} draft
 * @param {string} text
 */
function joinDraft(draft, text) {
  const last = draft.length > 0 ? draft[draft.length - 1] : '';
  const first = text.length > 0 ? text[0] : '';
  const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
  const sep = isWord(last) && isWord(first) ? ' ' : '';
  return `${draft}${sep}${text}`;
}

/**
 * 浏览器端自适应静音分段器（design.md D5）。
 *
 * 相比 v1 固定 RMS 阈值的升级点：
 *   - 噪声底 EMA 跟踪：仅关门态且 RMS 明显低于开门阈值时更新，钳位
 *     [floorMin, floorMax]，防止持续强噪把门槛抬到语音不可达；
 *   - 双门限迟滞：open = max(noiseFloor*kOpen, absOpenMin)，close = open*closeRatio；
 *   - pre-roll 环形缓冲：触发时回带此前至多 preRollMs 毫秒音频，句首不吞字；
 *   - hangover：沿用"尾静音累积满 silenceMs 才判段结束"的拖尾语义；
 *   - 最短人声门：自动分段结束时累计人声 < minSpeechMs 的整段丢弃，
 *     不上传转写；手动 flush() 不受此限（对齐停止语义矩阵的"冲刷"承诺）。
 *
 * 兼容：显式传入 rmsThreshold 时进入 v1 等价固定阈值模式（无自适应、无回带、
 * 无最短人声门），既有调用方与测试语义完全不变。
 * @param {object} options
 * @param {number} [options.sampleRate] 16k
 * @param {number} [options.rmsThreshold] 显式传入 = v1 固定阈值模式
 * @param {number} [options.silenceMs] 默认 700ms
 * @param {number} [options.minSegmentMs] 默认 300ms
 * @param {number} [options.minSpeechMs] 自适应模式：段内累计人声下限，默认 300ms
 * @param {number} [options.preRollMs] 触发前回带时长，默认 250ms
 * @param {number} [options.floorMin] 噪声底下钳位，默认 0.002
 * @param {number} [options.floorMax] 噪声底上钳位，默认 0.03
 * @param {number} [options.kOpen] 开门阈值倍率，默认 3
 * @param {number} [options.closeRatio] 关门/开门比，默认 0.55
 * @param {number} [options.absOpenMin] 开门绝对下限（安静房间退化为 v1 行为），默认 0.01
 * @param {number} [options.calibrateMs] 启动校准窗口：只建底噪不触发，防环境噪声冷启动误判，默认 300ms
 * @param {number} [options.hardTriggerMin] 校准期内的绝对强触发下限（明显即语音），默认 0.1
 * @param {number} [options.emaAlpha] 噪声底平滑系数，默认 0.06
 * @param {(samples: Float32Array) => void} options.onSegment
 */
function createSilenceSegmenter({
  sampleRate = TARGET_SAMPLE_RATE,
  rmsThreshold,
  silenceMs = 700,
  minSegmentMs = 300,
  minSpeechMs = 300,
  preRollMs = 250,
  floorMin = 0.002,
  floorMax = 0.03,
  kOpen = 3,
  closeRatio = 0.55,
  absOpenMin = 0.01,
  calibrateMs = 300,
  hardTriggerMin = 0.1,
  emaAlpha = 0.06,
  onSegment,
}) {
  const legacy = typeof rmsThreshold === 'number';
  const preRollSamples = Math.round((preRollMs / 1000) * sampleRate);
  const calibrateSamples = Math.round((calibrateMs / 1000) * sampleRate);
  const clampFloor = (v) => Math.min(Math.max(v, floorMin), floorMax);

  let segment = [];        // 开门后的片段累积
  let segmentSamples = 0;
  let speechSamples = 0;   // 人声态（RMS ≥ 关门阈值）累计样本数
  let silenceSamples = 0;
  let speaking = false;
  let noiseFloor = floorMin;
  let preRing = [];        // 关门态最近音频（pre-roll 回带源）
  let preRingSamples = 0;
  let closedSamples = 0;   // 本次开门周期内关门态样本数（启动校准计时器）

  function resetAll() {
    segment = [];
    segmentSamples = 0;
    speechSamples = 0;
    silenceSamples = 0;
    speaking = false;
    preRing = [];
    preRingSamples = 0;
    if (!legacy) closedSamples = 0;
  }

  /** 是否仍在启动校准窗口内（仅自适应模式）。 */
  function calibrating() {
    return !legacy && closedSamples < calibrateSamples;
  }

  /** includeGate=true 时应用最短人声门（仅自动分段）；手动冲刷始终放行。 */
  function emit(includeGate) {
    if (segmentSamples === 0) return;
    const samples = concatFloat32(segment);
    const keep = !includeGate || (speechSamples / sampleRate) * 1000 >= minSpeechMs;
    resetAll();
    if (keep) onSegment(samples);
  }

  return {
    push(samples) {
      const rms = computeRms(samples);
      const openThreshold = legacy ? rmsThreshold : Math.max(clampFloor(noiseFloor) * kOpen, absOpenMin);

      if (!speaking) {
        closedSamples += samples.length;
        // 启动校准窗口：只允许快速建立噪声底，不触发开门（防冷启动把环境
        // 噪声当语音；窗口内音频进入 pre-ring，触发后随回带保留句首）。
        const calibratingNow = calibrating();
        // 校准期内仅放行"明显是语音"的绝对强触发（如用户点完麦克风立刻开口）。
        if ((!calibratingNow && rms >= openThreshold) || (!legacy && rms >= hardTriggerMin)) {
          speaking = true;
          segment = legacy ? [samples] : [...preRing, samples];
          segmentSamples = (legacy ? 0 : preRingSamples) + samples.length;
          speechSamples = samples.length;
          silenceSamples = 0;
          preRing = [];
          preRingSamples = 0;
          return;
        }
        if (!legacy) {
          // 校准期用大步长快速收敛到真实环境底；之后凡低于开门阈值的帧都
          // 慢速跟踪（触发帧永不参与更新，语音起始不会污染噪声底估计）。
          if (calibratingNow) {
            noiseFloor = clampFloor(noiseFloor * 0.8 + rms * 0.2);
          } else if (rms < openThreshold) {
            noiseFloor = clampFloor(noiseFloor * (1 - emaAlpha) + rms * emaAlpha);
          }
          preRing.push(samples);
          preRingSamples += samples.length;
          while (preRing.length > 0 && preRingSamples - preRing[0].length >= preRollSamples) {
            preRingSamples -= preRing[0].length;
            preRing.shift();
          }
        }
        return;
      }

      const closeThreshold = legacy ? rmsThreshold : openThreshold * closeRatio;
      segment.push(samples);
      segmentSamples += samples.length;
      if (rms >= closeThreshold) {
        speechSamples += samples.length;
        silenceSamples = 0;
      } else {
        silenceSamples += samples.length;
      }
      const silenceMsNow = (silenceSamples / sampleRate) * 1000;
      const segmentMs = (segmentSamples / sampleRate) * 1000;
      if (silenceMsNow >= silenceMs && segmentMs >= minSegmentMs) {
        emit(!legacy); // v1 固定阈值模式不设最短人声门，语义完全等价旧版
      }
    },
    flush() {
      emit(false);
    },
    reset() {
      resetAll();
    },
    get speaking() {
      return speaking;
    },
    get segmentSamples() {
      return segmentSamples;
    },
    /** 当前噪声底估计（v1 固定阈值模式为 null），诊断用。 */
    get noiseFloor() {
      return legacy ? null : clampFloor(noiseFloor);
    },
  };
}

/**
 * 串行转写/追加器：保证多个音频段按入队顺序转写并追加，不出现乱序。
 * @param {object} deps
 * @param {() => string} deps.readDraft 同步读取最新草稿
 * @param {(text: string) => void} deps.setDraft 写入草稿（inputActions.setDraft）
 * @param {(samples: Float32Array) => Promise<string>} deps.transcribe 转写一段音频
 */
function createSerialAppender({ readDraft, setDraft, transcribe }) {
  let queue = Promise.resolve();
  return {
    append(samples) {
      const run = queue.then(async () => {
        const text = await transcribe(samples);
        const trimmed = (text ?? '').trim();
        if (trimmed === '') return;
        const draft = typeof readDraft === 'function' ? readDraft() : '';
        const next = joinDraft(draft, trimmed);
        if (typeof setDraft === 'function') setDraft(next);
      });
      queue = run.catch(() => {});
      return run;
    },
    get idle() {
      return queue;
    },
  };
}

/**
 * 光标处插入（design.md D8）：把 insert 插到 text 的 caret 位置，
 * 在新文本与两侧英文/数字边界处补空格防粘连。
 * @returns {{ value: string, caret: number }} 拼接结果与新光标位置（插入文本末尾）
 */
function composeInsertion({ text, caret, insert }) {
  const pos = Math.max(0, Math.min(typeof caret === 'number' ? caret : text.length, text.length));
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
  const lastBefore = before.length > 0 ? before[before.length - 1] : '';
  const firstInsert = insert.length > 0 ? insert[0] : '';
  const lastInsert = insert.length > 0 ? insert[insert.length - 1] : '';
  const firstAfter = after.length > 0 ? after[0] : '';
  const sepBefore = isWord(lastBefore) && isWord(firstInsert) ? ' ' : '';
  const sepAfter = isWord(lastInsert) && isWord(firstAfter) ? ' ' : '';
  return {
    value: `${before}${sepBefore}${insert}${sepAfter}${after}`,
    caret: pos + sepBefore.length + insert.length,
  };
}


// ===== fragment: manual-edit.js =====
/**
 * dsh-voice-local 浏览器端：手动编辑分类器与编辑自停守卫。
 *
 * 判定一个 beforeinput 事件是否属于"会产生内容变化的用户手动编辑"，
 * 并提供容器级委托守卫（E1：监听挂稳定容器而非 textarea 本体，防宿主
 * 重渲染替换节点导致监听落在 detached 元素上静默失效）。
 */

/**
 * 内容变更类 beforeinput inputType 白名单（design.md E5）：
 * 打字 / IME 组合 / 粘贴 / 拖放 / 替换 / 各类删除 / 撤销重做。
 * 方向键、焦点移动等不产生 beforeinput；产生但不含在此表的（如
 * insertLineBreak 由回车触发）按宿主语义另行评估，当前不视为编辑。
 */
const CONTENT_EDIT_INPUT_TYPES = new Set([
  'insertText',
  'insertCompositionText',
  'insertFromPaste',
  'insertFromDrop',
  'insertReplacementText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteByCut',
  'deleteByDrag',
  'historyUndo',
  'historyRedo',
]);

/** 是否为应触发打字自停的内容变更编辑。 */
function isContentEditInput(inputType) {
  return typeof inputType === 'string' && CONTENT_EDIT_INPUT_TYPES.has(inputType);
}

/**
 * 容器级 beforeinput 委托守卫。
 * @param {object} opts
 * @param {Element|null|undefined} opts.container 监听挂载的稳定容器（可空 → 返回 noop detach）
 * @param {() => boolean} opts.armed 守卫是否武装（录音中且开关开启且目标是本入口）
 * @param {(event: InputEvent) => void} opts.onEdit 命中内容变更编辑时回调
 * @returns {() => void} detach 函数
 */
function attachManualEditGuard({ container, armed, onEdit }) {
  if (container === null || container === undefined) return () => {};
  const handler = (event) => {
    if (!armed()) return;
    if (isContentEditInput(event.inputType)) onEdit(event);
  };
  container.addEventListener('beforeinput', handler, true);
  return () => container.removeEventListener('beforeinput', handler, true);
}

/** 自停偏好持久化键（悬浮开关状态；默认开）。 */
const AUTOSTOP_STORAGE_KEY = 'dsh-voice-local:autoStopOnType';

/** 读取自停开关（无记录/存储不可用 → 默认 true）。 */
function readAutoStopPref() {
  try {
    const raw = window.localStorage.getItem(AUTOSTOP_STORAGE_KEY);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

/** 写入自停开关。 */
function writeAutoStopPref(enabled) {
  try {
    window.localStorage.setItem(AUTOSTOP_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* 隐私模式等：仅内存态 */ }
}


// ===== fragment: hotkey.js =====
/**
 * dsh-voice-local 浏览器端：快捷键纯函数 + 单一 DOM 绑定器（design D4/D7）。
 *
 * 全部为纯函数或纯 DOM，不依赖 React 与 dictation，因此可像 pure.js / manual-edit.js
 * 一样被 build.mjs 拼接进 client bundle，并可独立单测。
 *
 * 绑定串采用规范形 `Mod+Alt+V`（`Mod` = Win/Linux 的 Ctrl、macOS 的 Cmd），
 * 显示时按平台渲染为 `Ctrl+Alt+V` / `⌘⌥V`。
 *
 * 触发决策树（document 捕获阶段 keydown）：
 *   处于捕获态？ ────────────────→ 交给捕获控件消费（attachHotkey 的 active=false）
 *   repeat / isComposing / 229？ ─→ 忽略
 *   命中当前绑定？
 *        └─ onTrigger(event) 返回 true（目标已解析且可动作）
 *             → preventDefault + stopPropagation
 *           返回 false（目标为 null / 不可用）→ 放行按键交还控件（OV-11）
 */

/** 规范键位持久化键。 */
const HOTKEY_STORAGE_KEY = 'dsh-voice-local:hotkey';
/**
 * 默认键位 `Mod+Alt+V`（V for Voice）。
 *
 * 为什么不默认 Space 系：`Ctrl+Space` 是 Win/Linux 输入法切换、macOS 选择输入源；
 * `Ctrl+Shift+Space` 被 Chrome 的翻译类扩展（Google Translate 等）默认占用——
 * 维护者实测该组合被扩展吞掉、页面收不到 keydown，表现为"按了没反应"。
 * 双修饰键 + 字母 V 不在浏览器内置快捷键表内，也不与输入法切换冲突。
 */
const DEFAULT_HOTKEY = 'Mod+Alt+V';

const MOD_TOKENS = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

const KEY_ALIASES = {
  ' ': 'Space',
  spacebar: 'Space',
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

const NAMED_KEYS = [
  'PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete', 'Backspace', 'Tab', 'Enter', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'CapsLock', 'Clear', 'ContextMenu',
  'PrintScreen', 'ScrollLock', 'Pause', 'NumLock',
];
const NAMED_KEY_MAP = Object.fromEntries(NAMED_KEYS.map((name) => [name.toLowerCase(), name]));

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);

/** 平台判定：macOS 用 Cmd（Meta）作 Mod，其余平台用 Ctrl。 */
function detectPlatform(nav) {
  const source = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (source === undefined || source === null) return 'linux';
  const ua = `${source.userAgent ?? ''} ${source.platform ?? ''}`.toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(ua)) return 'darwin';
  if (ua.includes('win')) return 'win32';
  return 'linux';
}

function isMac(platform) {
  const p = platform ?? detectPlatform();
  return p === 'darwin' || p === 'mac' || p === 'macos' || p === 'ios';
}

/** 键名规范化（大小写不敏感）：' ' → Space、'a' → A、'f11' → F11。 */
function canonicalKey(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower];
  if (NAMED_KEY_MAP[lower] !== undefined) return NAMED_KEY_MAP[lower];
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  if (/^[a-z0-9]+$/i.test(raw)) return raw.length === 1 ? raw.toUpperCase() : raw[0].toUpperCase() + raw.slice(1);
  if (raw.length === 1) return raw; // 单字符符号键（-, ., / 等）
  return null; // 未知多字符串：视为非法，避免把任意垃圾串当成合法键位
}

/** 纯修饰键（不能作为主键）。 */
function isModifierKey(key) {
  return MODIFIER_KEYS.has(key) || key === 'Meta' || key === 'Alt';
}

/**
 * 由物理键码 `event.code` 推导规范键名。
 *
 * 为什么需要它：`event.key` 会随修饰键与键盘布局变化——macOS 上 Option+V 的
 * `event.key` 是 `'√'`、部分欧洲布局 AltGr 组合会给出符号；此时按字母匹配会失败，
 * 用户会看到"明明绑定了却按不出来"。物理 code（KeyV / Digit1 / Space / F11）稳定。
 */
function keyFromCode(code) {
  if (typeof code !== 'string' || code === '') return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1];
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad !== null) return numpad[1];
  if (NAMED_KEY_MAP[code.toLowerCase()] !== undefined) return NAMED_KEY_MAP[code.toLowerCase()];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return null;
}

/** 事件 → 规范主键：优先物理 code，回退 event.key（都不认识返回 null）。 */
function keyFromEvent(event) {
  if (event === null || event === undefined) return null;
  const fromCode = keyFromCode(event.code);
  if (fromCode !== null) return fromCode;
  return canonicalKey(event.key);
}

/**
 * 解析规范串 / 用户输入串为结构化键位；非法（纯修饰键、多主键、空）返回 null。
 * @returns {{mod:boolean,ctrl:boolean,meta:boolean,alt:boolean,shift:boolean,key:string}|null}
 */
function parseHotkey(value) {
  if (typeof value !== 'string') return null;
  const tokens = value.split('+').map((token) => token.trim()).filter((token) => token !== '');
  if (tokens.length === 0) return null;
  const parsed = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: null };
  let keys = 0;
  for (const token of tokens) {
    const modifier = MOD_TOKENS[token.toLowerCase()];
    if (modifier !== undefined) {
      parsed[modifier] = true;
      continue;
    }
    const key = canonicalKey(token);
    if (key === null || isModifierKey(key)) return null;
    parsed.key = key;
    keys += 1;
    if (keys > 1) return null; // 多个主键非法
  }
  if (parsed.key === null) return null; // 仅有修饰键而无主键
  return parsed;
}

/** 结构化键位 → 规范串（持久化格式，与平台无关）。 */
function toCanonicalString(parsed) {
  if (parsed === null || parsed === undefined || parsed.key === null) return null;
  const parts = [];
  if (parsed.mod) parts.push('Mod');
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.meta && !parsed.mod) parts.push('Meta');
  if (parsed.shift) parts.push('Shift');
  parts.push(parsed.key);
  return parts.join('+');
}

/**
 * 按平台渲染显示串：`Mod+Alt+V` → `Ctrl+Alt+V`（Win/Linux）/ `⌘⌥V`（macOS）。
 * @param {string|object} value
 * @param {{platform?:string}} [options]
 */
function formatHotkey(value, options = {}) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : value;
  if (parsed === null || parsed === undefined || parsed.key === null) return '';
  const mac = isMac(options.platform);
  const parts = [];
  if (parsed.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (parsed.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
  if (parsed.alt) parts.push(mac ? '⌥' : 'Alt');
  if (parsed.meta && !parsed.mod) parts.push(mac ? '⌘' : 'Meta');
  if (parsed.shift) parts.push(mac ? '⇧' : 'Shift');
  return mac ? `${parts.join('')}${parsed.key}` : [...parts, parsed.key].join('+');
}

/**
 * 事件是否命中绑定：修饰键精确匹配（不多不少），忽略按住自动重复与输入法组合中的按键。
 * @param {KeyboardEvent} event
 * @param {string|object} hotkey
 * @param {{platform?:string}} [options]
 */
function matchHotkey(event, hotkey, options = {}) {
  const parsed = typeof hotkey === 'string' ? parseHotkey(hotkey) : hotkey;
  if (parsed === null || parsed === undefined || event === null || event === undefined) return false;
  if (event.repeat === true) return false; // 按住不放不重复触发
  if (event.isComposing === true || event.keyCode === 229) return false; // IME 组合中
  const mac = isMac(options.platform);
  const needCtrl = parsed.ctrl || (parsed.mod && !mac);
  const needMeta = parsed.meta || (parsed.mod && mac);
  if (event.ctrlKey !== needCtrl) return false;
  if (event.metaKey !== needMeta) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  // 主键同时看物理 code 与 event.key：mac Option+字母、非美式布局下 event.key 会是
  // 特殊字符（如 Option+V → '√'），只比 event.key 会漏判。
  if (keyFromEvent(event) === parsed.key) return true;
  return keyFromCode(event.code) === parsed.key;
}

/**
 * 浏览器/系统保留键判定（拒绝绑定）。
 * 覆盖 Ctrl/Meta（含 Mod）+ W/T/N/L/Tab、F11/F12、Alt+F4，以及纯修饰键组合。
 */
function isReserved(value) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : value;
  if (parsed === null || parsed === undefined || parsed.key === null) return true;
  const primary = parsed.ctrl || parsed.meta || parsed.mod;
  if (primary && ['W', 'T', 'N', 'L', 'Tab'].includes(parsed.key)) return true;
  if (['F11', 'F12'].includes(parsed.key)) return true;
  if (parsed.alt && parsed.key === 'F4') return true;
  return false;
}

/**
 * 是否与输入法 / 系统 / 常见浏览器扩展冲突（允许绑定，但提示可能失效）。
 *
 * 已知冲突（实测与社区事实）：
 *   - `Ctrl+Space`：Windows/Linux 输入法切换、macOS 选择上一个输入源；
 *   - `Mod+Space`：macOS Spotlight；
 *   - `Ctrl+Shift+Space`：Chrome 的翻译类扩展（如 Google Translate）默认占用
 *     ——维护者实测该组合被扩展吞掉、页面收不到 keydown；这也是默认键位不再
 *     使用 Space 系组合的原因。
 */
function isImeConflict(value) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : value;
  if (parsed === null || parsed === undefined || parsed.key === null) return false;
  if (parsed.alt) return false;
  if (parsed.key !== 'Space') return false;
  // 任何 Ctrl/Mod + Space（含 +Shift）都可能被系统、输入法或扩展占用
  return parsed.ctrl || parsed.mod;
}

/**
 * 绑定前的可读判定：reserved/invalid 直接拒绝，conflict 允许绑定但提示。
 * @returns {{kind:'invalid'|'reserved'|'conflict', message:string}|null}
 */
function describeHotkeyIssue(value) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : value;
  if (parsed === null || parsed === undefined || parsed.key === null) {
    return { kind: 'invalid', message: '请同时按下一个主键（只按修饰键无法作为快捷键）' };
  }
  if (isReserved(parsed)) {
    return { kind: 'reserved', message: '该组合是浏览器或系统保留键，无法绑定' };
  }
  if (isImeConflict(parsed)) {
    return { kind: 'conflict', message: '该组合可能被操作系统、输入法或浏览器扩展占用而失效' };
  }
  return null;
}

/**
 * 捕获态解析：Esc 取消；纯修饰键/重复/组合中按键不算（返回 ignore）；
 * 保留键与非法组合拒绝；冲突组合允许绑定但附带提示。
 * @returns {{status:'cancelled'|'ignore'|'rejected'|'bound', hotkey?:string, display?:string, message?:string, warning?:string|null}}
 */
function captureHotkey(event, options = {}) {
  if (event === null || event === undefined) return { status: 'ignore' };
  if (event.key === 'Escape') return { status: 'cancelled' };
  if (event.repeat === true || event.isComposing === true || event.keyCode === 229) return { status: 'ignore' };
  // 用物理 code 优先推导主键：macOS Option+字母 的 event.key 是特殊字符（'√'），
  // 直接取 event.key 会把绑定写成一个不可复现的符号键。
  const key = keyFromEvent(event);
  if (key === null || isModifierKey(key)) return { status: 'ignore' }; // 纯修饰键不算，必须有主键
  const mac = isMac(options.platform);
  const parsed = {
    mod: mac ? event.metaKey === true : event.ctrlKey === true,
    ctrl: mac ? event.ctrlKey === true : false,
    meta: mac ? false : event.metaKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    key,
  };
  const issue = describeHotkeyIssue(parsed);
  if (issue !== null && issue.kind !== 'conflict') {
    return { status: 'rejected', message: issue.message };
  }
  const hotkey = toCanonicalString(parsed);
  return {
    status: 'bound',
    hotkey,
    display: formatHotkey(parsed, options),
    warning: issue === null ? null : issue.message,
  };
}

// ---- 偏好持久化（localStorage 不可用时降级为内存态） ----
let memoryHotkey = DEFAULT_HOTKEY;

/**
 * 读取快捷键偏好。存储不可用 → 内存态；值缺失 → 默认；值损坏（无法解析）
 * → 回落默认**并写回清理损坏值**（D6 定案：静默失效不可接受）。
 */
function readHotkeyPref() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(HOTKEY_STORAGE_KEY);
  } catch {
    return memoryHotkey;
  }
  if (raw === null) {
    memoryHotkey = DEFAULT_HOTKEY;
    return DEFAULT_HOTKEY;
  }
  const parsed = parseHotkey(raw);
  if (parsed !== null) {
    const canonical = toCanonicalString(parsed);
    memoryHotkey = canonical;
    return canonical;
  }
  memoryHotkey = DEFAULT_HOTKEY;
  try { window.localStorage.setItem(HOTKEY_STORAGE_KEY, DEFAULT_HOTKEY); } catch { /* 仅内存态 */ }
  return DEFAULT_HOTKEY;
}

/** 写入快捷键偏好（规范化为规范串）；存储不可用时仅更新内存态。 */
function writeHotkeyPref(value) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : null;
  const canonical = parsed === null ? DEFAULT_HOTKEY : toCanonicalString(parsed);
  memoryHotkey = canonical;
  try { window.localStorage.setItem(HOTKEY_STORAGE_KEY, canonical); } catch { /* 仅内存态 */ }
  return canonical;
}

/** 测试/热重载用：内存态归位。 */
function resetHotkeyPrefMemory() {
  memoryHotkey = DEFAULT_HOTKEY;
}

/**
 * 文档级捕获绑定器。命中绑定后调用 `onTrigger(event)`：
 *   - 返回 true → 该按键被消费（preventDefault + stopPropagation）；
 *   - 返回 false/null → 目标未解析或不可用，放行按键交还控件（OV-11）。
 * @param {object} opts
 * @param {string|(() => string)} [opts.hotkey] 静态绑定串或读取函数
 * @param {() => string} [opts.getHotkey] 动态读取（优先）
 * @param {() => boolean} [opts.active] 是否武装（捕获态应返回 false）
 * @param {(event: KeyboardEvent) => boolean} opts.onTrigger
 * @param {Document} [opts.target]
 * @returns {() => void} detach
 */
function attachHotkey({ hotkey, getHotkey, active = () => true, onTrigger, target } = {}) {
  const doc = target ?? (typeof document !== 'undefined' ? document : null);
  if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function') return () => {};
  const read = typeof getHotkey === 'function' ? getHotkey : () => hotkey;
  const handler = (event) => {
    const current = read();
    if (typeof current !== 'string' || current === '') return;
    if (!matchHotkey(event, current)) return;
    if (!active()) return;
    const consumed = typeof onTrigger === 'function' ? onTrigger(event) : false;
    if (consumed === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  doc.addEventListener('keydown', handler, true);
  return () => doc.removeEventListener('keydown', handler, true);
}


// ===== fragment: dictation.js =====
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

const API_BASE = '/dsh-voice-local/v1';

/**
 * 只读审计钩子（任务 9.4）：默认关闭；开启时记录写入与快捷键事件，供 issue 复现时 dump。
 * 内部排障设施、不属于行为契约——钩子失效不算违约；**绝不**调用任何 submit/发送路径。
 * 用法：`window.__dshVoiceLocalDebug = { enabled: true, events: [] }` 后再操作。
 */
function recordVoiceDebug(kind, payload) {
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
function filtersIncomplete(status) {
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

function createDictationController({
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


// ===== fragment: question-injector.js =====
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

const GLYPH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  + '<line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** 原生 DOM 麦克风控件：麦克风按钮 + ⋮ 配置菜单；状态镜像 controller.subscribe。 */
function createMicControl({ controller, makeTarget, guardContainer, canStart = () => true }) {
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
    // 可用性判定单一真源（评审 D3）：按钮 disabled 与快捷键启动判定都读 canStart()。
    btn.disabled = s.mode === 'recording' ? false : !canStart();
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
  let composing = false; // IME 组合期跟踪（任务 9.3）
  let currentBound = null;
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };
  function bindComposition(node) {
    if (currentBound === node) return;
    if (currentBound !== null) {
      currentBound.removeEventListener('compositionstart', onCompositionStart, true);
      currentBound.removeEventListener('compositionend', onCompositionEnd, true);
    }
    currentBound = node;
    if (node !== null && node !== undefined) {
      node.addEventListener('compositionstart', onCompositionStart, true);
      node.addEventListener('compositionend', onCompositionEnd, true);
    }
  }
  bindComposition(ta);
  return {
    id: `question:${key}`,
    live: () => currentTa.isConnected === true,
    acceptsWrites: () => currentTa.disabled !== true,
    /** 供目标注册表判定"焦点是否落在本卡"（D5）。 */
    element: () => currentTa,
    isComposing: () => composing,
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
      composing = false;
      bindComposition(nextNode);
      console.warn(`[dsh-voice-local] question ${key} textarea retargeted (same-question re-render)`);
      return true;
    },
  };
}

function createQuestionInjector({ controller }) {
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
    // 提问卡的可用性判定（评审 D3）：control 未 disabled 且非转写/下载中。
    const canStart = () => {
      const live = controller.getState();
      return live.mode === 'idle' && live.downloading !== true && target.live() && target.acceptsWrites();
    };
    const control = createMicControl({
      controller,
      guardContainer: frame,
      makeTarget: () => target,
      canStart,
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
    // 目标注册（D5）：文档级快捷键按焦点解析时，本卡回答框命中即录向本卡。
    const unregister = controller.registerTarget({
      id: target.id,
      target,
      element: () => target.element(),
      canStart,
    });
    entries.set(key, { frame, control, target, questionIndex, unregister });
  }

  function unmount(key) {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    if (typeof entry.unregister === 'function') entry.unregister();
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


// ===== fragment: client.js =====
/**
 * dsh-voice-local web 端（client 插件入口）：
 * 输入框工具行麦克风按钮（薄壳）→ 共享听写控制器（dictation.js）→
 * AudioWorklet 录音 → 浏览器静音检测分段 → 逐段转写 → 光标处写入输入目标。
 *
 * 提问卡片入口由 question-injector.js 注入，与本入口共享同一控制器。
 */

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
