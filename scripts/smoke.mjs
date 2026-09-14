#!/usr/bin/env node
/**
 * dsh-voice-local 真实模型冒烟测试（慢速 lane，不拖累每次 PR）。
 *
 * 用法：
 *   node scripts/smoke.mjs [wav路径] [期望文本路径]
 *
 * 无参时默认使用入库 fixture `test/fixtures/voice-zh-16k.wav`（评审 OV-2 定案：
 * 该 lane 必须在 tag/发布前可自动触发，否则"判定时长与真实语音成比例"这条
 * 语义网只在有人记得手动点时存在）。
 *
 * 断言形状而非硬编码常数：
 *   - 同一 fixture 的**两个不同长度切片**分别过守门 → 两次 speechMs 不相等
 *     且均高于门限（这是"判定值恒为常数"这一类失效的直接探测器）；
 *   - 期望文本缺失时仅验证转写返回非空字符串。
 * 同时检查噪声过滤器组件（增强项：缺失时旁路，不影响主链路判定）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { modelDir, modelReady, readWavSamples, transcribeWavBuffer } from '../lib/transcriber.js';
import { audioFilterModelStatus, filterPipeline, TARGET_SAMPLE_RATE } from '../lib/audio-filter.js';
import { guardTranscript } from '../lib/text-guard.js';

/** 无参默认 fixture（相对仓库根，与 smoke.yml 的默认输入保持一致）。 */
export const DEFAULT_SMOKE_FIXTURE = fileURLToPath(new URL('../test/fixtures/voice-zh-16k.wav', import.meta.url));
/** 双切片断言使用的短切片长度（秒）。 */
export const SHORT_SLICE_SECONDS = 3;
/** 守门默认门限，与 lib/index.js 的 config.vad.minSpeechMs 默认值一致。 */
const DEFAULT_MIN_SPEECH_MS = 400;

const WAV = process.argv[2] || DEFAULT_SMOKE_FIXTURE;
const EXPECTED_FILE = process.argv[3];

const wavBuffer = await readFile(WAV);
console.log('模型目录:', modelDir());
console.log('模型就绪:', await modelReady());
console.log('音频文件:', WAV, '(' + wavBuffer.length + ' bytes)');

// 守门管线检查（增强组件：缺失时旁路，不影响冒烟主链路）
const filterStatus = await audioFilterModelStatus();
console.log('过滤器模型:', JSON.stringify(filterStatus));
let guardInfo = 'skipped(过滤器模型缺失)';
const guard = { ran: false, fullMs: null, shortMs: null };
if (filterStatus.vad) {
  try {
    const { samples } = readWavSamples(wavBuffer);
    if (samples.length > 0) {
      const fr = await filterPipeline(samples, {});
      guardInfo = 'speech=' + fr.speech + ' speechMs=' + (fr.speechMs ?? '-') + ' denoised=' + fr.denoised;
      const shortLen = Math.min(Math.round(SHORT_SLICE_SECONDS * TARGET_SAMPLE_RATE), samples.length);
      const shortFr = await filterPipeline(samples.subarray(0, shortLen), {});
      guard.ran = true;
      guard.fullMs = fr.speechMs;
      guard.shortMs = shortFr.speechMs;
      console.log('守门判定（全长）:', JSON.stringify({ speech: fr.speech, speechMs: fr.speechMs, denoised: fr.denoised, gateReason: fr.gateReason ?? null }));
      console.log('守门判定（前 ' + SHORT_SLICE_SECONDS + 's 切片）:', JSON.stringify({ speech: shortFr.speech, speechMs: shortFr.speechMs, denoised: shortFr.denoised, gateReason: shortFr.gateReason ?? null }));
    }
  } catch (cause) {
    guardInfo = 'bypass(' + (cause?.message ?? cause) + ')';
  }
}
console.log('守门判定:', guardInfo);

// 真实模型语义网：两个不同长度切片的判定值必须不同且都高于门限。
// 只断言"形状"（不相等 + 过门 + 均非 null），不硬编码 3442/2074 这类常数。
if (guard.ran) {
  const problems = [];
  if (!Number.isFinite(guard.fullMs) || !Number.isFinite(guard.shortMs)) {
    problems.push('speechMs 非数值（守门组件旁路了？）');
  } else {
    if (guard.fullMs === guard.shortMs) {
      problems.push(`两次判定值相同（${guard.fullMs}ms）——疑似"判定值恒为常数"类失效`);
    }
    if (guard.fullMs < DEFAULT_MIN_SPEECH_MS || guard.shortMs < DEFAULT_MIN_SPEECH_MS) {
      problems.push(`长/短切片判定值 ${guard.fullMs}ms / ${guard.shortMs}ms 未同时高于门限 ${DEFAULT_MIN_SPEECH_MS}ms`);
    }
    if (!(guard.fullMs > guard.shortMs)) {
      problems.push(`更长的切片判定值应更大：full=${guard.fullMs}ms short=${guard.shortMs}ms`);
    }
  }
  if (problems.length > 0) {
    console.error('❌ 守门比例断言失败:');
    for (const p of problems) console.error('   -', p);
    process.exit(1);
  }
  console.log(`✅ 守门比例断言通过：全长 ${guard.fullMs}ms > 前 ${SHORT_SLICE_SECONDS}s 切片 ${guard.shortMs}ms，且均高于门限 ${DEFAULT_MIN_SPEECH_MS}ms`);
}

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
