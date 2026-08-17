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
import { nativeModuleStatus, nativeFixMessage, SHERPA_VERSION } from '../lib/arch.js';
import { modelDir, modelReady, modelFiles } from '../lib/transcriber.js';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const asJson = args.has('--json');

const status = nativeModuleStatus();
const model = {
  dir: modelDir(),
  files: modelFiles(),
  ready: await modelReady(),
};

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
  problems,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`dsh-voice-local doctor`);
  console.log(`  node:       ${process.version} (${platform()}/${arch()})`);
  console.log(`  sherpa:     ${status.addonLoads ? 'OK' : 'BROKEN'}  wanted=${status.wanted}  resolved=${status.platformResolved}`);
  console.log(`  model:      ${model.ready ? 'OK' : 'NOT READY'}  ${model.dir}`);
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
