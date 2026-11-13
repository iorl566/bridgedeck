// tools/build-embed-skill.mjs —— 把 skill/ 编成 cli/embedded-skill.mjs（单文件内置技能）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skill');
const OUT = path.join(ROOT, 'cli', 'embedded-skill.mjs');
const files = {};
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files[path.relative(SKILL_DIR, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
}
walk(SKILL_DIR);
const names = Object.keys(files).sort();
const version = crypto.createHash('sha256').update(names.map((name) => name + '\0' + files[name]).join('\0')).digest('hex').slice(0, 16);
const lines = ['// cli/embedded-skill.mjs —— 由 tools/build-embed-skill.mjs 生成，勿手改。', `export const SKILL_VERSION = '${version}';`, 'export const SKILL_FILES = {'];
for (const name of names) lines.push('  ' + JSON.stringify(name) + ': ' + JSON.stringify(files[name]) + ',');
lines.push('};', '');
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('embedded skill', names.length, 'files', version, '->', OUT);
