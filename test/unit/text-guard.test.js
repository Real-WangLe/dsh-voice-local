import test from 'node:test';
import assert from 'node:assert/strict';
import { guardTranscript, sanitizeTranscript } from '../../lib/text-guard.js';

test('幻觉残留整句被丢弃', () => {
  assert.equal(guardTranscript('谢谢观看。'), '');
  assert.equal(guardTranscript('感谢收看！'), '');
  assert.equal(guardTranscript('Thank you.'), '');
  assert.equal(guardTranscript('Thanks for watching!'), '');
  assert.equal(guardTranscript('Please subscribe.'), '');
});

test('字幕署名形状被丢弃', () => {
  assert.equal(guardTranscript('字幕由Opus提供'), '');
  assert.equal(guardTranscript('字幕由社区制作。'), '');
  assert.equal(guardTranscript('Subtitles by XYZ Team'), '');
  assert.equal(guardTranscript('amara.org community captions'), '');
});

test('单字符超长重复被判定为幻觉', () => {
  assert.equal(guardTranscript('哈哈哈哈哈哈哈哈哈哈哈哈'), ''); // 同一单元覆盖全句
  assert.equal(guardTranscript('aaaaaaaaaaaa'), '');
  assert.equal(guardTranscript('嗯嗯嗯嗯嗯嗯嗯嗯'), '');
});

test('孤立标点/纯符号返回空', () => {
  assert.equal(guardTranscript('。。。'), '');
  assert.equal(guardTranscript(' !? '), '');
  assert.equal(guardTranscript('   '), '');
});

test('正常短语句直通', () => {
  assert.equal(guardTranscript('好的，明天见'), '好的，明天见');
  assert.equal(guardTranscript('你好世界'), '你好世界');
  assert.equal(guardTranscript('这是一个测试。'), '这是一个测试。');
});

test('中英数字混排不被误杀', () => {
  assert.equal(guardTranscript('帮我查一下 GTCRN 的论文'), '帮我查一下 GTCRN 的论文');
  assert.equal(guardTranscript('版本号是 0.3.0'), '版本号是 0.3.0');
  assert.equal(guardTranscript('OK，我们开始吧'), 'OK，我们开始吧');
});

test('含"谢谢"但非残留整句的文本直通', () => {
  assert.equal(guardTranscript('谢谢你的帮助，明天见'), '谢谢你的帮助，明天见');
});

test('非字符串与空输入返回空', () => {
  assert.equal(guardTranscript(undefined), '');
  assert.equal(guardTranscript(null), '');
  assert.equal(guardTranscript(''), '');
});

test('控制字符净化：去除回车、换行折叠为空格，中英混排不受影响', () => {
  assert.equal(sanitizeTranscript('你好\r\n世界'), '你好 世界');
  assert.equal(sanitizeTranscript('你好\n世界'), '你好 世界');
  assert.equal(sanitizeTranscript('a\rb'), 'ab');
  assert.equal(sanitizeTranscript('a\n\n\nb'), 'a b');
  assert.equal(sanitizeTranscript('第一行\nsecond line'), '第一行 second line');

  assert.equal(guardTranscript('你好\n世界'), '你好 世界');
  assert.equal(guardTranscript('  识别结果\r\n'), '识别结果');
  assert.ok(!guardTranscript('帮我查一下 GTCRN 的论文\n谢谢').includes('\n'));
  assert.ok(!/\r|\n/.test(guardTranscript('版本号是 0.3.0\r\n')));
});
