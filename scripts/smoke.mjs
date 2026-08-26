#!/usr/bin/env node
/**
 * dsh-voice-local 真实模型冒烟测试（不进入默认 CI 的慢速 lane）。
 *
 * 用法：
 *   node scripts/smoke.mjs <wav路径> [期望文本路径]
 *
 * 期望文本缺失时仅验证转写返回非空字符串。
 * 同时检查噪声过滤器组件（增强项：缺失时旁路，不影响主链路判定）。
 */
import { readFile } from 'node:fs/promises';
import { modelDir, modelReady, readWavSamples, transcribeWavBuffer } from '../lib/transcriber.js';
import { audioFilterModelStatus, filterPipeline } from '../lib/audio-filter.js';
import { guardTranscript } from '../lib/text-guard.js';

const WAV = process.argv[2];
const EXPECTED_FILE = process.argv[3];

if (!WAV) {
  console.error('用法: node scripts/smoke.mjs <wav路径> [期望文本路径]');
  process.exit(1);
}

const wavBuffer = await readFile(WAV);
console.log('模型目录:', modelDir());
console.log('模型就绪:', await modelReady());
console.log('音频文件:', WAV, '(' + wavBuffer.length + ' bytes)');

// 守门管线检查（增强组件：缺失时旁路，不影响冒烟主链路）
const filterStatus = await audioFilterModelStatus();
console.log('过滤器模型:', JSON.stringify(filterStatus));
let guardInfo = 'skipped(过滤器模型缺失)';
if (filterStatus.vad && filterStatus.denoiser) {
  try {
    const { samples } = readWavSamples(wavBuffer);
    if (samples.length > 0) {
      const fr = await filterPipeline(samples, {});
      guardInfo = 'speech=' + fr.speech + ' speechMs=' + (fr.speechMs ?? '-') + ' denoised=' + fr.denoised;
    }
  } catch (cause) {
    guardInfo = 'bypass(' + (cause?.message ?? cause) + ')';
  }
}
console.log('守门判定:', guardInfo);

let start = Date.now();
const text = await transcribeWavBuffer(wavBuffer);
const ms = Date.now() - start;
console.log('转写结果:', JSON.stringify(text), '(' + ms + ' ms)');
const guardedText = guardTranscript(text);
if (guardedText !== text.trim()) {
  console.log('幻觉兜底:', JSON.stringify(guardedText), guardedText === '' ? '(整段被拦)' : '(已清洗)');
}

if (typeof text !== 'string' || text.trim() === '') {
  console.error('❌ 转写结果为空');
  process.exit(1);
}

if (EXPECTED_FILE) {
  const expected = (await readFile(EXPECTED_FILE, 'utf8')).trim();
  const norm = (s) => s.toLowerCase().replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】\]]+/g, '');
  const got = norm(text);
  const want = norm(expected);
  // 简单包含/相似度检查；真实模型与标点可能略有差异
  const ok = got.includes(want) || want.includes(got);
  console.log('期望:', JSON.stringify(expected));
  console.log(ok ? '✅ MATCH' : '❌ MISMATCH');
  if (!ok) process.exit(1);
} else {
  console.log('✅ 转写链路正常（未提供期望文本，仅验证非空）');
}
