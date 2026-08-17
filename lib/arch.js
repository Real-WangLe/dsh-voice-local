/**
 * dsh-voice-local 原生模块（sherpa-onnx）架构诊断。
 *
 * sherpa-onnx-node 通过 optionalDependencies 声明平台包（sherpa-onnx-<platform>-<arch>），
 * npm/pnpm 安装时按「安装进程的 node 架构」自动选装。若安装环境与 dsh host 架构不一致
 * （例如 Apple Silicon 上默认终端是 Rosetta/x64 而 host 是 arm64），运行时会报
 * "Could not find sherpa-onnx-node"。本模块负责检测、给出可操作的修复指引。
 */
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export const SHERPA_VERSION = '1.13.5';

/** 与 sherpa-onnx-node/addon.js 相同的平台包命名（win32 特殊映射）。 */
export function platformPackageName() {
  const os = platform() === 'win32' ? 'win' : platform();
  return `sherpa-onnx-${os}-${arch()}`;
}

/** sherpa-onnx-node 包所在目录（找不到返回 null）。 */
export function sherpaRoot() {
  try {
    return dirname(require.resolve('sherpa-onnx-node/package.json'));
  } catch {
    return null;
  }
}

/**
 * 完整诊断当前进程能否加载 sherpa-onnx 原生绑定。
 * @returns {{ arch, platform, wanted, root, addonLoads, addonError, platformResolved }}
 */
export function nativeModuleStatus() {
  const wanted = platformPackageName();
  const root = sherpaRoot();
  let addonLoads = false;
  let addonError = null;
  try {
    require('sherpa-onnx-node/addon.js');
    addonLoads = true;
  } catch (cause) {
    addonError = cause instanceof Error ? cause.message : String(cause);
  }
  let platformResolved = false;
  if (root !== null) {
    const candidates = [join(root, 'node_modules', wanted), join(dirname(root), wanted)];
    platformResolved = candidates.some((dir) => existsSync(join(dir, 'sherpa-onnx.node')));
  }
  return { arch: arch(), platform: platform(), wanted, root, addonLoads, addonError, platformResolved };
}

/** 判断错误是否为「sherpa-onnx 原生模块缺失/加载失败」。 */
export function isNativeModuleError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /Could not find sherpa-onnx-node/.test(message) || /sherpa-onnx.*(native|\.node)/i.test(message);
}

/** 生成可操作的修复指引文本。 */
export function nativeFixMessage(status = nativeModuleStatus()) {
  const { arch: a, platform: p, wanted, addonError } = status;
  const lines = [
    `dsh-voice-local 原生转写模块（sherpa-onnx）无法加载：当前 node 进程是 ${p}/${a}，需要平台包 ${wanted}@${SHERPA_VERSION}。`,
  ];
  if (addonError !== null) lines.push(`原始错误：${addonError.split('\n')[0]}`);
  lines.push(
    '',
    '修复 1 —— 在 dsh profile 目录补装对应平台包（把 <profile> 换成 ~/.dsh/profiles/web 或你的 profile）：',
    `  cd <profile> && npm install --no-save --registry=https://registry.npmjs.org ${wanted}@${SHERPA_VERSION}`,
    '  或（pnpm）：',
    `  cd <profile> && pnpm add ${wanted}@${SHERPA_VERSION} --registry=https://registry.npmjs.org`,
    '',
    '修复 2 —— 若平台包已在但仍是 pnpm 虚拟 store 漏链，手动补符号链接：',
    `  cd <profile>/node_modules/.pnpm/sherpa-onnx-node@${SHERPA_VERSION}/node_modules \\`,
    `    && ln -s ../../${wanted}@${SHERPA_VERSION}/node_modules/${wanted} ${wanted}`,
    '',
    '提示：Apple Silicon 上若默认终端是 Rosetta（x64），请用原生终端或 `arch -arm64` 前缀安装，',
    '确保安装架构与 dsh host 的 node 架构一致（可用 `node -p process.arch` 检查）。',
  );
  return lines.join('\n');
}

/** 把普通错误包装成带修复指引的 rich error（挂 .code / .fix / .nativeStatus）。 */
export function asNativeModuleError(cause) {
  const status = nativeModuleStatus();
  const error = new Error(nativeFixMessage(status), { cause });
  error.code = 'native-module-missing';
  error.fix = nativeFixMessage(status);
  error.nativeStatus = status;
  return error;
}

/**
 * 在调用进程内探测 resampler 模块的真实状态（诊断用，/diagnose 端点）。
 * @returns {{ arch, platform, resolved, resolvedError, exports, ctorType, requireError, requireStack }}
 */
export function probeResampler() {
  const out = {
    arch: arch(),
    platform: platform(),
    resolved: null,
    resolvedError: null,
    exports: null,
    ctorType: null,
    requireError: null,
    requireStack: null,
  };
  try {
    out.resolved = require.resolve('sherpa-onnx-node/resampler.js');
  } catch (cause) {
    out.resolvedError = cause instanceof Error ? cause.message : String(cause);
  }
  try {
    const mod = require('sherpa-onnx-node/resampler.js');
    out.exports = Object.keys(mod);
    out.ctorType = typeof mod.LinearResampler;
  } catch (cause) {
    out.requireError = cause instanceof Error ? cause.message : String(cause);
    out.requireStack = cause instanceof Error ? cause.stack : null;
  }
  return out;
}
