import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelReady } from '../../lib/transcriber.js';

test('modelReady returns false for zero-byte model files and true for non-empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-ready-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.int8.onnx'), '');
    await writeFile(join(dir, 'tokens.txt'), '');
    assert.equal(await modelReady(dir), false);

    await writeFile(join(dir, 'model.int8.onnx'), 'data');
    await writeFile(join(dir, 'tokens.txt'), 'tokens');
    assert.equal(await modelReady(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
