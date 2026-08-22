#!/usr/bin/env node
/**
 * Build script for dsh-voice-local.
 *
 * Copies the plain-JS host sources from lib/ into dist/, then assembles the
 * browser bundle `dist/client.js` from ordered fragments:
 *
 *   [pure.js, manual-edit.js, dictation.js, question-injector.js, client.js]
 *
 * Fragment contract (keeps us bundler-free while staying real ESM for Node
 * unit tests):
 *   - each fragment is a normal ES module in lib/
 *   - single-line `import ...` statements only, no default exports
 *   - the build strips import lines and `^export ` prefixes, then concatenates
 *     the bodies in dependency order; lib/client.js stays last and keeps the
 *     `window.__ModuleLoader__.load({ id, factory })` wrapper, whose factory
 *     closes over the preceding top-level declarations
 *
 * Delivery contract: the host loads exactly one file, `dist/client.js`.
 */
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'lib');
const dist = resolve(root, 'dist');

/** Browser bundle fragments, concat order = dependency order. */
const CLIENT_FRAGMENTS = [
  'pure.js',
  'manual-edit.js',
  'dictation.js',
  'question-injector.js',
  'client.js',
];

/** Strip one-line ESM imports and `^export ` declaration prefixes. */
function toFragmentBody(source, fileName) {
  const lines = source.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*import\s/.test(line)) {
      if (!/;\s*$/.test(line)) {
        throw new Error(`build: ${fileName} has a multi-line import; keep imports on one line`);
      }
      continue;
    }
    out.push(line.replace(/^export\s+(?=(async\s+)?(function|const|let|var|class)\b)/, ''));
  }
  return out.join('\n');
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });

const parts = [];
for (const name of CLIENT_FRAGMENTS) {
  const source = await readFile(resolve(src, name), 'utf8');
  parts.push(`// ===== fragment: ${name} =====\n${toFragmentBody(source, name)}`);
}
const banner = [
  '/**',
  ' * GENERATED FILE — do not edit.',
  ' * Assembled by scripts/build.mjs from lib/{pure,manual-edit,dictation,question-injector,client}.js',
  ' */',
  '',
].join('\n');
await writeFile(resolve(dist, 'client.js'), banner + parts.join('\n\n'), 'utf8');

console.log(`build: copied lib/ -> dist/ and assembled dist/client.js from ${CLIENT_FRAGMENTS.length} fragments`);
