#!/usr/bin/env node
/**
 * Build script for dsh-voice-local.
 *
 * Copies the plain-JS host/client sources from lib/ into dist/ so the package
 * exports (".", "./client") always point at the built browser bundle and host
 * entry. No transpilation is required for the current ES2020 browser target.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'lib');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });
console.log(`build: copied lib/ -> dist/ (${dist})`);
