#!/usr/bin/env node
/**
 * dsh-voice-local 真实模型冒烟测试（不进入默认 CI 的慢速 lane）。
 *
 * 用法：
 *   node scripts/smoke.mjs <wav路径> [期望文本路径]
 *
 * 期望文本缺失时仅验证转写返回非空字符串。
 */
import { readFile } from 'node:fs/promises';
import { modelDir, modelReady, transcribeWavBuffer } from '../lib/transcriber.js';

const WAV = process.argv[2];
const EXPECTED_FILE = process.argv[3];

if (!WAV) {
  console.error('用法: node scripts/smoke.mjs <wav路径> [期望文本路径]');
  process.exit(1);
}

const wavBuffer = await readFile(WAV);
console.log('模型目录:', modelDir());
console.log('模型就绪:', await modelReady());
console.log('音频文件:', WAV, `(${wavBuffer.length} bytes)`);

let start = Date.now();
const text = await transcribeWavBuffer(wavBuffer);
const ms = Date.now() - start;
console.log('转写结果:', JSON.stringify(text), `(${ms} ms)`);

if (typeof text !== 'string' || text.trim() === '') {
  console.error('❌ 转写结果为空');
  process.exit(1);
}

if (EXPECTED_FILE) {
  const expected = (await readFile(EXPECTED_FILE, 'utf8')).trim();
  const norm = (s) => s.toLowerCase().replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]]+/g, '');
  const got = norm(text);
  const want = norm(expected);
  // 简单包含/相似度检查；真实模型与标点可能略有差异
  const ok = got.includes(want) || want.includes(got);
  console.log(`期望: ${JSON.stringify(expected)}`);
  console.log(ok ? '✅ MATCH' : '❌ MISMATCH');
  if (!ok) process.exit(1);
} else {
  console.log('✅ 转写链路正常（未提供期望文本，仅验证非空）');
}
