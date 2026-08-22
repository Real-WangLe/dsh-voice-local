import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  CONTENT_EDIT_INPUT_TYPES,
  isContentEditInput,
  attachManualEditGuard,
  AUTOSTOP_STORAGE_KEY,
  readAutoStopPref,
  writeAutoStopPref,
} from '../../lib/manual-edit.js';

test('classifier accepts content-changing input types incl. undo/redo/replace', () => {
  for (const t of [
    'insertText',
    'insertCompositionText',
    'insertFromPaste',
    'insertFromDrop',
    'insertReplacementText',
    'deleteContentBackward',
    'deleteWordForward',
    'deleteByCut',
    'historyUndo',
    'historyRedo',
  ]) {
    assert.equal(isContentEditInput(t), true, t);
  }
});

test('classifier rejects non-content or unknown input types', () => {
  for (const t of [undefined, '', 'insertLineBreak', 'insertParagraph', 'formatBold', 'compositionupdate']) {
    assert.equal(isContentEditInput(t), false, String(t));
  }
  // 白名单本身不含段落级换行（宿主回车语义另行评估）
  assert.equal(CONTENT_EDIT_INPUT_TYPES.has('insertParagraph'), false);
});

test('attachManualEditGuard fires only when armed and only for content edits', () => {
  const dom = new JSDOM('<div id="card"><textarea id="ta"></textarea></div>');
  const { document } = dom.window;
  const card = document.getElementById('card');
  const ta = document.getElementById('ta');

  let armedFlag = true;
  let hits = 0;
  const detach = attachManualEditGuard({
    container: card,
    armed: () => armedFlag,
    onEdit: () => { hits += 1; },
  });

  const fire = (inputType) => ta.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType, bubbles: true }));

  fire('insertText');           // armed + content edit
  fire('deleteContentBackward'); // armed + delete
  fire('insertParagraph');       // armed + 非内容编辑
  armedFlag = false;
  fire('insertText');           // 未武装

  assert.equal(hits, 2);
  detach();
  fire('insertText');
  assert.equal(hits, 2); // detach 后不再触发
});

test('attachManualEditGuard tolerates null container', () => {
  const detach = attachManualEditGuard({ container: null, armed: () => true, onEdit: () => {} });
  assert.equal(typeof detach, 'function');
  detach();
});

test('autostop preference defaults to enabled and persists round-trip', () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  try {
    assert.equal(readAutoStopPref(), true); // 默认开
    writeAutoStopPref(false);
    assert.equal(dom.window.localStorage.getItem(AUTOSTOP_STORAGE_KEY), '0');
    assert.equal(readAutoStopPref(), false);
    writeAutoStopPref(true);
    assert.equal(readAutoStopPref(), true);
  } finally {
    delete global.window;
  }
});
