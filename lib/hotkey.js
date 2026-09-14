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
export const HOTKEY_STORAGE_KEY = 'dsh-voice-local:hotkey';
/**
 * 默认键位 `Mod+Alt+V`（V for Voice）。
 *
 * 为什么不默认 Space 系：`Ctrl+Space` 是 Win/Linux 输入法切换、macOS 选择输入源；
 * `Ctrl+Shift+Space` 被 Chrome 的翻译类扩展（Google Translate 等）默认占用——
 * 维护者实测该组合被扩展吞掉、页面收不到 keydown，表现为"按了没反应"。
 * 双修饰键 + 字母 V 不在浏览器内置快捷键表内，也不与输入法切换冲突。
 */
export const DEFAULT_HOTKEY = 'Mod+Alt+V';

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
export function detectPlatform(nav) {
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
export function canonicalKey(raw) {
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
export function keyFromCode(code) {
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
export function keyFromEvent(event) {
  if (event === null || event === undefined) return null;
  const fromCode = keyFromCode(event.code);
  if (fromCode !== null) return fromCode;
  return canonicalKey(event.key);
}

/**
 * 解析规范串 / 用户输入串为结构化键位；非法（纯修饰键、多主键、空）返回 null。
 * @returns {{mod:boolean,ctrl:boolean,meta:boolean,alt:boolean,shift:boolean,key:string}|null}
 */
export function parseHotkey(value) {
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
export function toCanonicalString(parsed) {
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
export function formatHotkey(value, options = {}) {
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
export function matchHotkey(event, hotkey, options = {}) {
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
export function isReserved(value) {
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
export function isImeConflict(value) {
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
export function describeHotkeyIssue(value) {
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
export function captureHotkey(event, options = {}) {
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
export function readHotkeyPref() {
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
export function writeHotkeyPref(value) {
  const parsed = typeof value === 'string' ? parseHotkey(value) : null;
  const canonical = parsed === null ? DEFAULT_HOTKEY : toCanonicalString(parsed);
  memoryHotkey = canonical;
  try { window.localStorage.setItem(HOTKEY_STORAGE_KEY, canonical); } catch { /* 仅内存态 */ }
  return canonical;
}

/** 测试/热重载用：内存态归位。 */
export function resetHotkeyPrefMemory() {
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
export function attachHotkey({ hotkey, getHotkey, active = () => true, onTrigger, target } = {}) {
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
