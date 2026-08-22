#!/usr/bin/env node
/**
 * dsh-voice-local doctor — 安装后/排障诊断。
 *
 * 用法：
 *   node scripts/doctor.mjs           完整诊断；有问题时 exit 1
 *   node scripts/doctor.mjs --check   快速检查；仅打印警告，永远 exit 0
 *   node scripts/doctor.mjs --json    机器可读输出
 */
import { arch, platform } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativeModuleStatus, nativeFixMessage, SHERPA_VERSION } from '../lib/arch.js';
import { modelDir, modelReady, modelFiles } from '../lib/transcriber.js';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const asJson = args.has('--json');

/**
 * 宿主提问卡锚点检查（E3）：在已安装的宿主 web 前端包内查找
 * `data-question-key` 是否仍然存在——这是问题卡语音入口的 DOM 契约。
 * 找不到宿主包时报告 unknown，不视为故障。
 */
function checkQuestionAnchor() {
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const pkgNames = ['dsh-web-frontend', 'dsh-web-app', 'dsh-client-ui-user-questions'];
  const bases = [
    join(base, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  ];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    bases.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
    bases.push(join(globalRoot, '@deepseek-ai'));
  } catch { /* npm 不可用：跳过全局根 */ }
  const candidates = [];
  for (const b of bases) for (const n of pkgNames) candidates.push(join(b, n));
  let lastExisting = null;
  for (const pkg of candidates) {
    if (!existsSync(pkg)) continue;
    lastExisting = pkg;
    let found = false;
    let scanned = 0;
    const stack = [pkg];
    while (stack.length > 0 && scanned < 400 && !found) {
      const dir = stack.pop();
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch { continue; }
      for (const entry of dirents) {
        const full = join(dir, entry.name);
        if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
          scanned += 1;
          try {
            if (readFileSync(full, 'utf8').includes('data-question-key')) { found = true; break; }
          } catch { /* skip unreadable */ }
        } else if (entry.isDirectory() && entry.name !== 'node_modules') {
          stack.push(full);
        }
      }
    }
    if (found) return { pkg, found: true, scanned };
  }
  return { pkg: lastExisting, found: lastExisting === null ? null : false, scanned: 0 };
}

const status = nativeModuleStatus();
const model = {
  dir: modelDir(),
  files: modelFiles(),
  ready: await modelReady(),
};
const anchor = checkQuestionAnchor();

const problems = [];
if (!status.addonLoads) {
  problems.push('原生模块不可用：sherpa-onnx-node 无法加载（架构/平台包问题）');
}
if (status.addonLoads && !status.platformResolved) {
  problems.push(`平台包 ${status.wanted} 未解析（${status.platform}/${status.arch}）`);
}
if (!model.ready) {
  problems.push(`SenseVoice 模型未就绪（${model.dir}），首次使用会自动下载（约 230MB）`);
}
if (anchor.found === false) {
  problems.push('宿主前端未找到 data-question-key 锚点：提问卡语音入口将不可用（fail-open，其余功能不受影响）。可能原因：DSH 升级改变了卡片结构');
}

const report = {
  ok: problems.length === 0,
  node: { arch: arch(), platform: platform(), version: process.version },
  sherpa: {
    version: SHERPA_VERSION,
    addonLoads: status.addonLoads,
    wanted: status.wanted,
    platformResolved: status.platformResolved,
    root: status.root,
    addonError: status.addonError,
  },
  model: { ready: model.ready, dir: model.dir, files: model.files },
  questionAnchor: anchor,
  problems,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`dsh-voice-local doctor`);
  console.log(`  node:       ${process.version} (${platform()}/${arch()})`);
  console.log(`  sherpa:     ${status.addonLoads ? 'OK' : 'BROKEN'}  wanted=${status.wanted}  resolved=${status.platformResolved}`);
  console.log(`  model:      ${model.ready ? 'OK' : 'NOT READY'}  ${model.dir}`);
  console.log(`  q-anchor:   ${anchor.found === null ? 'UNKNOWN（未找到宿主前端包）' : anchor.found ? 'OK' : 'MISSING'}${anchor.pkg !== null ? `  (${anchor.pkg})` : ''}`);
  if (status.addonError !== null) {
    console.log(`  addon err:  ${status.addonError.split('\n')[0]}`);
  }
  if (problems.length > 0) {
    console.log('');
    console.log(`⚠ ${problems.length} 个问题:`);
    for (const p of problems) console.log(`  - ${p}`);
    if (!status.addonLoads) {
      console.log('');
      console.log(nativeFixMessage(status));
    }
    if (!model.ready) {
      console.log('');
      console.log('手动下载 / 离线导入模型：');
      console.log(`  mkdir -p ${model.dir}`);
      console.log('  下载官方 tar.bz2 后解压，将 model.int8.onnx 与 tokens.txt 放入上述目录即可。');
      console.log('  或设置 DSH_VOICE_MIRROR_URL / DSH_VOICE_MIRRORS 后运行：node tools/download-model.mjs');
    }
  } else {
    console.log('  全部正常 ✅');
  }
}

if (checkOnly) process.exit(0);
process.exit(report.ok ? 0 : 1);
