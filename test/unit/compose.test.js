import test from 'node:test';
import assert from 'node:assert/strict';
import { composeInsertion, joinDraft } from '../../lib/pure.js';

test('composeInsertion inserts at caret and reports caret after inserted text', () => {
  const r = composeInsertion({ text: '你好世界', caret: 2, insert: '很好' });
  assert.equal(r.value, '你好很好世界');
  assert.equal(r.caret, 4);
});

test('composeInsertion at end equals append semantics of joinDraft', () => {
  for (const [base, ins] of [['hello ', 'world'], ['中文', '文本'], ['', '开头']]) {
    const r = composeInsertion({ text: base, caret: base.length, insert: ins });
    assert.equal(r.value, joinDraft(base, ins));
    assert.equal(r.caret, r.value.length);
  }
});

test('composeInsertion adds boundary space between english/digits on both sides', () => {
  // 左边界：字母 + 字母 → 补空格
  let r = composeInsertion({ text: 'use', caret: 3, insert: 'react' });
  assert.equal(r.value, 'use react');
  // 右边界：数字+字母、字母+字母都补空格
  r = composeInsertion({ text: 'v2core', caret: 2, insert: 'x' });
  assert.equal(r.value, 'v2 x core');
  // 中文两侧不补空格
  r = composeInsertion({ text: '前端框架', caret: 2, insert: '最好' });
  assert.equal(r.value, '前端最好框架');
  assert.equal(r.caret, 4);
});

test('composeInsertion clamps out-of-range carets', () => {
  let r = composeInsertion({ text: 'abc', caret: -5, insert: 'X' });
  assert.equal(r.value, 'X abc'); // 左侧钳到 0，右边界 X|a 补空格
  r = composeInsertion({ text: 'abc', caret: 99, insert: 'X' });
  assert.equal(r.value, 'abc X'); // 右侧钳到末尾，左边界 c|X 补空格
  // 非数值 caret 视为末尾
  r = composeInsertion({ text: 'abc', caret: undefined, insert: 'X' });
  assert.equal(r.value, 'abc X');
  assert.equal(r.caret, 5);
});

test('composeInsertion handles empty insert as no-op with unchanged caret', () => {
  const r = composeInsertion({ text: 'abc', caret: 1, insert: '' });
  assert.equal(r.value, 'abc');
  assert.equal(r.caret, 1);
});
