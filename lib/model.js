/**
 * dsh-voice-local SenseVoice 模型管理：后台下载 / 进度 / 镜像 / SHA256 / 重试。
 *
 * 设计：
 * - 下载在后台执行，/model/download 立即返回，/model/status 轮询进度。
 * - 支持 mirrorUrl 优先、失败回退默认 URL。
 * - 下载完成后校验 SHA256（配置提供时）并解压，原子移动到目标目录。
 * - 同一时间只允许一个下载任务；卸载时可 abort。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { modelDir as resolveModelDir, modelFiles, modelReady } from './transcriber.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2';
export const MODEL_ARCHIVE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2';

// 默认镜像列表：按顺序尝试，全部失败后回退主 URL。
// 代理类镜像稳定性不一，用户可用 DSH_VOICE_MIRRORS 覆盖。
export const DEFAULT_MIRRORS = [
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
];

// 默认“文件直下”镜像：这些地址不是 tar.bz2，而是 Hugging Face 仓库根，
// 插件会自动拼接 resolve/main/model.int8.onnx 与 tokens.txt。
export const DEFAULT_FILE_MIRRORS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
];

function isArchiveUrl(url) {
  return /\.(tar\.bz2|tar\.gz|tgz)(\?|$)/i.test(url);
}

function resolveFileUrl(base, filename) {
  const b = base.replace(/\/+$/, '');
  if (/\/resolve\/main$/i.test(b)) return `${b}/${filename}`;
  if (/\/resolve\/main\/$/i.test(b)) return `${b}${filename}`;
  return `${b}/resolve/main/${filename}`;
}

async function downloadDirectFiles(baseUrl, destDir, onProgress, signal, fetchImpl) {
  const modelUrl = resolveFileUrl(baseUrl, 'model.int8.onnx');
  const tokensUrl = resolveFileUrl(baseUrl, 'tokens.txt');
  await downloadFile(modelUrl, join(destDir, 'model.int8.onnx'), onProgress, signal, fetchImpl);
  await downloadFile(tokensUrl, join(destDir, 'tokens.txt'), onProgress, signal, fetchImpl);
}

// 下载完成后由维护者写入官方归档/模型文件 SHA256；为空时跳过强校验（见 README 安全说明）。
export const DEFAULT_MODEL_SHA256 = '';

const DOWNLOAD_STATE = {
  status: 'idle', // idle | downloading | ready | error
  progress: 0,    // 0..1
  downloadedBytes: 0,
  totalBytes: 0,
  message: '',
  error: null,
  startedAt: null,
  finishedAt: null,
};

let inflight = null;
let abortController = null;

export function getDownloadState() {
  return { ...DOWNLOAD_STATE, error: DOWNLOAD_STATE.error };
}

function setState(patch) {
  Object.assign(DOWNLOAD_STATE, patch);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadFile(url, destPath, onProgress, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}（${url}）`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  const file = createWriteStream(destPath);
  const reader = response.body?.getReader();
  if (reader === undefined) {
    file.end();
    throw new Error(`响应无 body（${url}）`);
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      onProgress(received, total);
      if (!file.write(Buffer.from(value))) {
        await new Promise((resolve) => file.once('drain', resolve));
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      file.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function run(cmd, args) {
  try {
    await execFileAsync(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (cause) {
    const stderr = cause?.stderr ? `\n${cause.stderr}` : '';
    throw new Error(`命令 ${cmd} 执行失败：${cause?.message ?? cause}${stderr}`);
  }
}

async function extractArchive(archive, extractDir) {
  try {
    await run('tar', ['-xjf', archive, '--strip-components=1', '-C', extractDir]);
  } catch (cause) {
    const hint = 'tar 解压失败；可设置 DSH_VOICE_MIRROR_URL 为 Hugging Face 仓库地址（直连文件模式）或手动解压模型文件。';
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}。${hint}`);
  }
}

async function moveFile(src, dest) {
  // Windows 上 rename 无法覆盖已存在文件，先删除目标。
  await rm(dest, { force: true }).catch(() => {});
  await rename(src, dest);
}

export async function modelStatus(dir = resolveModelDir()) {
  const files = modelFiles(dir);
  const detail = {};
  for (const [name, path] of Object.entries(files)) {
    try {
      const s = await stat(path);
      detail[name] = { bytes: s.size };
    } catch {
      detail[name] = null;
    }
  }
  return { dir, ready: await modelReady(dir), files: detail, download: getDownloadState() };
}

async function verifySha256(filePath, expected) {
  if (typeof expected !== 'string' || expected.trim() === '') return;
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`);
  }
}

/**
 * 启动（或复用）后台模型下载。
 * @param {object} [options]
 * @param {string} [options.dir]
 * @param {string} [options.modelUrl]
 * @param {string} [options.mirrorUrl]
 * @param {string} [options.sha256]
 * @param {number} [options.retries]
 * @returns {Promise<object>} 下载完成后的状态
 */
export function downloadModel(options = {}) {
  if (inflight !== null) return inflight;
  const dir = resolveModelDir(options.dir, options.modelDir);
  const modelUrl = options.modelUrl ?? process.env.DSH_VOICE_MODEL_URL ?? DEFAULT_MODEL_URL;
  const mirrorUrl = options.mirrorUrl ?? process.env.DSH_VOICE_MIRROR_URL ?? '';
  const sha256 = options.sha256 ?? process.env.DSH_VOICE_MODEL_SHA256 ?? DEFAULT_MODEL_SHA256;
  const modelSha256 = options.modelSha256 ?? process.env.DSH_VOICE_MODEL_FILE_SHA256 ?? '';
  const tokensSha256 = options.tokensSha256 ?? process.env.DSH_VOICE_TOKENS_SHA256 ?? '';
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  const fetchImpl = options.fetchImpl ?? fetch;
  const extractImpl = options.extractImpl ?? extractArchive;

  inflight = (async () => {
    abortController = new AbortController();
    const startedAt = new Date().toISOString();
    setState({
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      message: '准备下载',
      error: null,
      startedAt,
      finishedAt: null,
    });

    if (await modelReady(dir)) {
      setState({ status: 'ready', progress: 1, message: '模型已存在', finishedAt: new Date().toISOString() });
      const result = { already: true, ...(await modelStatus(dir)) };
      abortController = null;
      inflight = null;
      return result;
    }

    const temp = join(tmpdir(), `dsh-voice-local-${randomUUID()}`);
    const archive = join(temp, MODEL_ARCHIVE);
    const extract = join(temp, 'extract');
    await mkdir(extract, { recursive: true });

    const urls = [];
    if (typeof mirrorUrl === 'string' && mirrorUrl.trim() !== '') urls.push(mirrorUrl.trim());
    if (Array.isArray(options.mirrors)) {
      for (const item of options.mirrors) {
        if (typeof item === 'string' && item.trim() !== '') urls.push(item.trim());
      }
    }
    if (typeof process.env.DSH_VOICE_MIRRORS === 'string' && process.env.DSH_VOICE_MIRRORS.trim() !== '') {
      for (const item of process.env.DSH_VOICE_MIRRORS.split(',')) {
        const value = item.trim();
        if (value !== '') urls.push(value);
      }
    }
    const isWindows = platform() === 'win32';
    const userPrimary = typeof modelUrl === 'string' && modelUrl.trim() !== '' ? modelUrl.trim() : '';
    if (userPrimary !== '' && !urls.includes(userPrimary)) {
      // Windows 上默认 GitHub tar 放最后，优先直连文件避免 tar 依赖
      if (!(isWindows && userPrimary === DEFAULT_MODEL_URL)) {
        urls.push(userPrimary);
      }
    }
    if (isWindows) {
      for (const item of DEFAULT_FILE_MIRRORS) urls.push(item);
      for (const item of DEFAULT_MIRRORS) urls.push(item);
    } else {
      for (const item of DEFAULT_MIRRORS) urls.push(item);
      for (const item of DEFAULT_FILE_MIRRORS) urls.push(item);
    }
    if (isWindows && userPrimary === DEFAULT_MODEL_URL && !urls.includes(userPrimary)) {
      urls.push(userPrimary);
    }
    if (urls.length === 0) urls.push(DEFAULT_MODEL_URL);

    try {
      let lastError = null;
      let downloadedMode = null; // 'archive' | 'files'
      for (const url of urls) {
        setState({ message: `下载中：${url}`, progress: 0, downloadedBytes: 0, totalBytes: 0 });
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            if (isArchiveUrl(url)) {
              await downloadFile(url, archive, (received, total) => {
                setState({
                  downloadedBytes: received,
                  totalBytes: total,
                  progress: total > 0 ? received / total : 0,
                });
              }, abortController.signal, fetchImpl);
              downloadedMode = 'archive';
            } else {
              await downloadDirectFiles(url, temp, (received, total) => {
                setState({
                  downloadedBytes: received,
                  totalBytes: total,
                  progress: total > 0 ? received / total : 0,
                });
              }, abortController.signal, fetchImpl);
              downloadedMode = 'files';
            }
            lastError = null;
            break;
          } catch (cause) {
            lastError = cause;
            if (abortController.signal.aborted) throw cause;
            if (attempt < retries) {
              setState({ message: `下载失败，重试 ${attempt + 1}/${retries}：${url}` });
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
            }
          }
        }
        if (lastError === null) break;
        setState({ message: `镜像/主源均失败：${url}` });
      }
      if (lastError !== null) throw lastError;

      await mkdir(dir, { recursive: true });
      if (downloadedMode === 'archive') {
        setState({ message: '校验 SHA256…', progress: 0.98 });
        await verifySha256(archive, sha256);

        setState({ message: '解压模型…', progress: 0.99 });
        await extractImpl(archive, extract);

        const model = join(extract, 'model.int8.onnx');
        const tokens = join(extract, 'tokens.txt');
        await access(model);
        await access(tokens);
        await moveFile(model, join(dir, 'model.int8.onnx'));
        await moveFile(tokens, join(dir, 'tokens.txt'));
      } else if (downloadedMode === 'files') {
        const model = join(temp, 'model.int8.onnx');
        const tokens = join(temp, 'tokens.txt');
        await access(model);
        await access(tokens);
        await verifySha256(model, modelSha256);
        await verifySha256(tokens, tokensSha256);
        await moveFile(model, join(dir, 'model.int8.onnx'));
        await moveFile(tokens, join(dir, 'tokens.txt'));
      } else {
        throw lastError ?? new Error('未选择任何可用下载源');
      }

      setState({ status: 'ready', progress: 1, message: '模型就绪', finishedAt: new Date().toISOString() });
      return { already: false, ...(await modelStatus(dir)) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setState({
        status: 'error',
        progress: 0,
        message: '下载失败',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      throw cause;
    } finally {
      await rm(temp, { force: true, recursive: true }).catch(() => {});
      abortController = null;
      inflight = null;
    }
  })();
  return inflight;
}

/** 中止当前下载（插件卸载时调用）。 */
export function abortDownload() {
  if (abortController !== null) {
    abortController.abort();
  }
}
