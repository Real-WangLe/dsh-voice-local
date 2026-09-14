import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  HOTKEY_STORAGE_KEY,
  DEFAULT_HOTKEY,
  detectPlatform,
  canonicalKey,
  parseHotkey,
  toCanonicalString,
  formatHotkey,
  matchHotkey,
  isReserved,
  isImeConflict,
  describeHotkeyIssue,
  captureHotkey,
  readHotkeyPref,
  writeHotkeyPref,
  resetHotkeyPrefMemory,
  attachHotkey,
} from '../../lib/hotkey.js';

/** 由键名推物理 code（真实浏览器里 code 与 key 是两套值，测试必须一起模拟）。 */
const CODE_BY_KEY = { ' ': 'Space', Space: 'Space', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Delete: 'Delete', Backspace: 'Backspace', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
function codeForKey(key) {
  if (CODE_BY_KEY[key] !== undefined) return CODE_BY_KEY[key];
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return key;
}

/** 构造键盘事件形状（纯对象，避免依赖 jsdom）。 */
function keyEvent(init = {}) {
  const base = {
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, keyCode: 32,
    ...init,
  };
  base.key = init.key ?? ' ';
  base.code = init.code ?? codeForKey(base.key);
  return base;
}

test('5.1 parse/format：规范串与平台显示互转，键名大小写不敏感', () => {
  assert.deepEqual(parseHotkey('Mod+Shift+Space'), { mod: true, ctrl: false, meta: false, alt: false, shift: true, key: 'Space' });
  assert.deepEqual(parseHotkey('ctrl+shift+space'), { mod: false, ctrl: true, meta: false, alt: false, shift: true, key: 'Space' });
  assert.deepEqual(parseHotkey('MOD+SHIFT+SPACE'), parseHotkey('Mod+Shift+Space'));
  assert.deepEqual(parseHotkey('Cmd+Shift+Space'), parseHotkey('Meta+Shift+Space'));

  assert.equal(formatHotkey('Mod+Shift+Space', { platform: 'linux' }), 'Ctrl+Shift+Space');
  assert.equal(formatHotkey('Mod+Shift+Space', { platform: 'win32' }), 'Ctrl+Shift+Space');
  assert.equal(formatHotkey('Mod+Shift+Space', { platform: 'darwin' }), '⌘⇧Space');
  assert.equal(formatHotkey('Ctrl+Space', { platform: 'darwin' }), '⌃Space');

  // 往返：parse → canonical → parse 等价
  for (const value of ['Mod+Shift+Space', 'Mod+Alt+A', 'Ctrl+Shift+Enter', 'Mod+F5', 'Ctrl+ArrowUp']) {
    const parsed = parseHotkey(value);
    assert.deepEqual(parseHotkey(toCanonicalString(parsed)), parsed, value);
  }

  // 非法：纯修饰键 / 多主键 / 空
  assert.equal(parseHotkey('Shift'), null);
  assert.equal(parseHotkey('Mod+Shift'), null);
  assert.equal(parseHotkey('A+B'), null);
  assert.equal(parseHotkey(''), null);
  assert.equal(parseHotkey(null), null);
});

test('5.1 canonicalKey 与平台探测', () => {
  assert.equal(canonicalKey(' '), 'Space');
  assert.equal(canonicalKey('spacebar'), 'Space');
  assert.equal(canonicalKey('a'), 'A');
  assert.equal(canonicalKey('f11'), 'F11');
  assert.equal(canonicalKey('pagedown'), 'PageDown');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' }), 'darwin');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }), 'win32');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }), 'linux');
});

test('5.2 matchHotkey：修饰键精确匹配（不多不少），忽略 repeat 与 IME 组合', () => {
  const base = { key: ' ', ctrlKey: true, shiftKey: true };
  assert.equal(matchHotkey(keyEvent(base), 'Mod+Shift+Space', { platform: 'linux' }), true);
  assert.equal(matchHotkey(keyEvent({ key: 'Space', ctrlKey: true, shiftKey: true }), 'Mod+Shift+Space', { platform: 'linux' }), true);
  // 多一个修饰键不算命中
  assert.equal(matchHotkey(keyEvent({ ...base, altKey: true }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  assert.equal(matchHotkey(keyEvent({ ...base, metaKey: true }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  // 少一个修饰键不算命中
  assert.equal(matchHotkey(keyEvent({ key: ' ', ctrlKey: true }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  // 主键不匹配
  assert.equal(matchHotkey(keyEvent({ ...base, key: 'A' }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  // 按住自动重复
  assert.equal(matchHotkey(keyEvent({ ...base, repeat: true }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  // IME 组合中
  assert.equal(matchHotkey(keyEvent({ ...base, isComposing: true }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  assert.equal(matchHotkey(keyEvent({ ...base, keyCode: 229 }), 'Mod+Shift+Space', { platform: 'linux' }), false);
  // macOS：Mod = Cmd（Meta）
  assert.equal(matchHotkey(keyEvent({ key: ' ', metaKey: true, shiftKey: true }), 'Mod+Shift+Space', { platform: 'darwin' }), true);
  assert.equal(matchHotkey(keyEvent(base), 'Mod+Shift+Space', { platform: 'darwin' }), false);
});

test('5.3 isReserved：浏览器/系统保留键黑名单 + 输入法冲突分类', () => {
  for (const value of ['Ctrl+W', 'Meta+T', 'Mod+N', 'Ctrl+L', 'Mod+Tab', 'F11', 'F12', 'Alt+F4']) {
    assert.equal(isReserved(value), true, value);
  }
  for (const value of ['Mod+Shift+Space', 'Ctrl+Shift+K', 'Alt+A', 'F10']) {
    assert.equal(isReserved(value), false, value);
  }
  assert.equal(isReserved('Shift'), true, '纯修饰键视为不可用');
  assert.equal(isReserved('NotAKey+X'), true, '非法组合视为不可用');

  assert.equal(isImeConflict('Mod+Space'), true);
  assert.equal(isImeConflict('Ctrl+Space'), true);
  // 维护者实测：Chrome 的翻译类扩展（Google Translate）默认占用 Ctrl+Shift+Space，
  // 会吞掉按键使页面收不到 keydown —— 纳入冲突提示（允许绑定但警告）。
  assert.equal(isImeConflict('Ctrl+Shift+Space'), true);
  assert.equal(isImeConflict('Mod+Alt+Space'), false, '带 Alt 不算已知冲突');
  assert.equal(isImeConflict('Mod+Alt+V'), false);

  assert.equal(describeHotkeyIssue('Shift').kind, 'invalid');
  assert.equal(describeHotkeyIssue('Ctrl+W').kind, 'reserved');
  assert.equal(describeHotkeyIssue('Mod+Space').kind, 'conflict');
  assert.equal(describeHotkeyIssue('Ctrl+Shift+Space').kind, 'conflict');
  assert.equal(describeHotkeyIssue('Mod+Alt+V'), null);
});

test('默认键位可用且无冲突提示（Mod+Alt+V / ⌘⌥V）', () => {
  assert.notEqual(parseHotkey(DEFAULT_HOTKEY), null);
  assert.equal(isReserved(DEFAULT_HOTKEY), false);
  assert.equal(isImeConflict(DEFAULT_HOTKEY), false, '默认键位不得带冲突提示');
  assert.equal(describeHotkeyIssue(DEFAULT_HOTKEY), null);
  assert.equal(formatHotkey(DEFAULT_HOTKEY, { platform: 'linux' }), 'Ctrl+Alt+V');
  assert.equal(formatHotkey(DEFAULT_HOTKEY, { platform: 'win32' }), 'Ctrl+Alt+V');
  assert.equal(formatHotkey(DEFAULT_HOTKEY, { platform: 'darwin' }), '⌘⌥V');
  assert.equal(
    matchHotkey(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true }), DEFAULT_HOTKEY, { platform: 'linux' }),
    true,
  );
  // macOS：Cmd+Option+V，且 Option 把 event.key 变成 '√' 时仍靠物理 code 命中
  assert.equal(
    matchHotkey(keyEvent({ key: '√', code: 'KeyV', metaKey: true, altKey: true }), DEFAULT_HOTKEY, { platform: 'darwin' }),
    true,
  );
});

test('物理 code 优先：mac Option+字母 / 非美式布局下 event.key 是特殊字符也能命中与捕获', () => {
  // macOS：Option+V 的 event.key 是 '√'，code 仍是 KeyV
  const macOptionV = keyEvent({ key: '√', code: 'KeyV', altKey: true });
  assert.equal(matchHotkey(macOptionV, 'Alt+V', { platform: 'darwin' }), true);
  const captured = captureHotkey(macOptionV, { platform: 'darwin' });
  assert.equal(captured.status, 'bound');
  assert.equal(captured.hotkey, 'Alt+V', '不得把绑定写成不可复现的符号键');
  assert.equal(captured.display, '⌥V');

  // 非美式布局：AltGr(=Ctrl+Alt) 下 event.key 是符号，code 仍是 KeyQ
  assert.equal(matchHotkey(keyEvent({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), 'Ctrl+Alt+Q', { platform: 'win32' }), true);
  // 没有 code 的环境回退 event.key
  assert.equal(matchHotkey(keyEvent({ key: 'v', code: '', ctrlKey: true, altKey: true }), 'Ctrl+Alt+V', { platform: 'win32' }), true);
});

test('5.4 captureHotkey：纯修饰键不算、必须有主键、Esc 取消、保留键拒绝、冲突键允许但提示', () => {
  assert.equal(captureHotkey(keyEvent({ key: 'Escape', ctrlKey: false }), { platform: 'linux' }).status, 'cancelled');
  // 纯修饰键：ignore（捕获态继续等待主键）
  assert.equal(captureHotkey(keyEvent({ key: 'Shift', shiftKey: true }), { platform: 'linux' }).status, 'ignore');
  assert.equal(captureHotkey(keyEvent({ key: 'Control', ctrlKey: true }), { platform: 'linux' }).status, 'ignore');
  // repeat / 组合中：ignore
  assert.equal(captureHotkey(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true, repeat: true }), { platform: 'linux' }).status, 'ignore');
  assert.equal(captureHotkey(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true, isComposing: true }), { platform: 'linux' }).status, 'ignore');

  const bound = captureHotkey(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }), { platform: 'linux' });
  assert.equal(bound.status, 'bound');
  assert.equal(bound.hotkey, 'Mod+Shift+Space');
  assert.equal(bound.display, 'Ctrl+Shift+Space');
  assert.match(bound.warning, /输入法|扩展|操作系统/, 'Space 系组合应给冲突提示（翻译类扩展实测占用）');

  const macBound = captureHotkey(keyEvent({ key: ' ', metaKey: true, shiftKey: true }), { platform: 'darwin' });
  assert.equal(macBound.hotkey, 'Mod+Shift+Space');
  assert.equal(macBound.display, '⌘⇧Space');

  const reserved = captureHotkey(keyEvent({ key: 'w', ctrlKey: true }), { platform: 'linux' });
  assert.equal(reserved.status, 'rejected');
  assert.match(reserved.message, /保留/);

  const conflict = captureHotkey(keyEvent({ key: ' ', ctrlKey: true }), { platform: 'linux' });
  assert.equal(conflict.status, 'bound');
  assert.equal(conflict.hotkey, 'Mod+Space');
  assert.match(conflict.warning, /输入法|操作系统/);
});

test('5.5 read/writeHotkeyPref：默认、往返、损坏值回落并清理、存储不可用降级内存态', () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  resetHotkeyPrefMemory();
  try {
    assert.equal(readHotkeyPref(), DEFAULT_HOTKEY, '无记录时为默认键位');
    assert.equal(writeHotkeyPref('Ctrl+Shift+K'), 'Ctrl+Shift+K');
    assert.equal(readHotkeyPref(), 'Ctrl+Shift+K');
    assert.equal(dom.window.localStorage.getItem(HOTKEY_STORAGE_KEY), 'Ctrl+Shift+K');

    // 大小写/别名规范化后落盘（规范串顺序与 formatHotkey 一致：Mod, Ctrl, Alt, Meta, Shift）
    assert.equal(writeHotkeyPref('cmd+alt+a'), 'Alt+Meta+A');
    assert.equal(readHotkeyPref(), 'Alt+Meta+A');

    // 损坏值：回落默认并写回清理
    dom.window.localStorage.setItem(HOTKEY_STORAGE_KEY, 'this-is-not-a-hotkey+');
    assert.equal(readHotkeyPref(), DEFAULT_HOTKEY);
    assert.equal(dom.window.localStorage.getItem(HOTKEY_STORAGE_KEY), DEFAULT_HOTKEY, '损坏值应被清理');

    // 非法写入回退默认
    assert.equal(writeHotkeyPref('Shift'), DEFAULT_HOTKEY);

    // 存储不可用 → 内存态
    resetHotkeyPrefMemory();
    const broken = new JSDOM('');
    Object.defineProperty(broken.window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
    global.window = broken.window;
    assert.equal(readHotkeyPref(), DEFAULT_HOTKEY);
    assert.equal(writeHotkeyPref('Ctrl+Alt+P'), 'Ctrl+Alt+P');
    assert.equal(readHotkeyPref(), 'Ctrl+Alt+P', '存储不可用时读回内存态');
  } finally {
    resetHotkeyPrefMemory();
    delete global.window;
  }
});

test('5.6 attachHotkey：捕获阶段命中即消费，active=false 或 onTrigger=false 时放行', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const doc = dom.window.document;
  let triggers = 0;
  let armed = true;
  const detach = attachHotkey({
    hotkey: 'Mod+Shift+Space',
    active: () => armed,
    onTrigger: () => { triggers += 1; return true; },
    target: doc,
  });
  const fire = (init) => {
    const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    doc.dispatchEvent(event);
    return event;
  };

  const hit = fire({ key: ' ', ctrlKey: true, shiftKey: true });
  assert.equal(triggers, 1);
  assert.equal(hit.defaultPrevented, true, '命中且已消费时应阻止默认行为');

  armed = false; // 捕获态挂起
  fire({ key: ' ', ctrlKey: true, shiftKey: true });
  assert.equal(triggers, 1, '未武装时不触发');

  armed = true;
  detach();
  fire({ key: ' ', ctrlKey: true, shiftKey: true });
  assert.equal(triggers, 1, 'detach 后不再触发');

  // onTrigger 返回 false（目标为 null）→ 放行按键，不 preventDefault（OV-11）
  const detach2 = attachHotkey({
    hotkey: 'Mod+Shift+Space',
    onTrigger: () => false,
    target: doc,
  });
  const passed = fire({ key: ' ', ctrlKey: true, shiftKey: true });
  assert.equal(passed.defaultPrevented, false, '目标为 null 时必须放行按键');
  detach2();
});
