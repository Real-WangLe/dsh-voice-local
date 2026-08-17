#!/usr/bin/env node
/**
 * dsh-voice-local 模型下载辅助脚本。
 *
 * 用法：
 *   node tools/download-model.mjs [--url <url>] [--mirror <url>] [--sha256 <hex>]
 *
 * 默认使用内置 GitHub release 地址；下载完成后校验 SHA256（如提供）。
 */
import { downloadModel, getDownloadState } from '../lib/model.js';
import { modelDir } from '../lib/transcriber.js';

const args = process.argv.slice(2);
function readArg(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const options = {
  modelUrl: readArg('--url'),
  mirrorUrl: readArg('--mirror'),
  sha256: readArg('--sha256'),
};

console.log(`模型目录: ${modelDir()}`);
console.log('开始下载（后台任务，Ctrl+C 可中断）…');

const promise = downloadModel(options);
// 简单进度轮询（脚本本身等待完成；真实插件由 /model/status 轮询）
const timer = setInterval(() => {
  const s = getDownloadState();
  if (s.status === 'downloading') {
    const pct = Math.round((s.progress || 0) * 100);
    process.stdout.write(`\r下载中 ${pct}%  ${s.downloadedBytes}/${s.totalBytes || '?'} bytes  ${s.message}`);
  }
}, 500);

try {
  const result = await promise;
  clearInterval(timer);
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));
} catch (cause) {
  clearInterval(timer);
  process.stdout.write('\n');
  console.error('下载失败:', cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
