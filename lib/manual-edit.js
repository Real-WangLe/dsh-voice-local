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
export const CONTENT_EDIT_INPUT_TYPES = new Set([
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
export function isContentEditInput(inputType) {
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
export function attachManualEditGuard({ container, armed, onEdit }) {
  if (container === null || container === undefined) return () => {};
  const handler = (event) => {
    if (!armed()) return;
    if (isContentEditInput(event.inputType)) onEdit(event);
  };
  container.addEventListener('beforeinput', handler, true);
  return () => container.removeEventListener('beforeinput', handler, true);
}

/** 自停偏好持久化键（悬浮开关状态；默认开）。 */
export const AUTOSTOP_STORAGE_KEY = 'dsh-voice-local:autoStopOnType';

/** 读取自停开关（无记录/存储不可用 → 默认 true）。 */
export function readAutoStopPref() {
  try {
    const raw = window.localStorage.getItem(AUTOSTOP_STORAGE_KEY);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

/** 写入自停开关。 */
export function writeAutoStopPref(enabled) {
  try {
    window.localStorage.setItem(AUTOSTOP_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* 隐私模式等：仅内存态 */ }
}
