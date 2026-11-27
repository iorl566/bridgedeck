#!/usr/bin/env node
// 依赖审计：许可证白名单 + vendored 副本与 node_modules 逐字节一致。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { auditLicenses, vendorDrift } from '../lib/deps-audit.mjs';

const ROOT = process.cwd();
const check = process.argv.includes('--check');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const names = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
const packages = [];
for (const name of names.sort()) {
  const manifestPath = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const license = typeof manifest.license === 'string'
    ? manifest.license
    : (Array.isArray(manifest.licenses) ? manifest.licenses.map((item) => item && item.type).filter(Boolean).join(' OR ') : '');
  packages.push({ name, version: manifest.version, license });
}
const licenses = auditLicenses(packages);

function sha(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
}
const sourceBundle = path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs');
const sourceLicense = path.join(ROOT, 'node_modules', 'mediabunny', 'LICENSE');
const entries = [];
for (const dir of ['cli/vendor/mediabunny', 'extension/vendor/mediabunny']) {
  entries.push({ path: dir + '/mediabunny.min.mjs', expectedHash: sha(sourceBundle), actualHash: sha(path.join(ROOT, dir, 'mediabunny.min.mjs')) });
  entries.push({ path: dir + '/LICENSE', expectedHash: sha(sourceLicense), actualHash: sha(path.join(ROOT, dir, 'LICENSE')) });
}
const drift = vendorDrift(entries);
const ok = licenses.ok && drift.ok;
console.log(JSON.stringify({
  ok,
  packages: licenses.rows,
  licenses: licenses.problems,
  vendor: drift.rows,
  vendorProblems: drift.problems,
}, null, 2));
if (!ok && check) process.exit(1);
