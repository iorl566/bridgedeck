import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const out = process.argv[3];
const buffer = readFileSync(path);
const offsets = [];
for (let index = 0; index < buffer.length - 4; index += 1) {
  if (buffer[index] === 0x4d && buffer[index + 1] === 0x53 && buffer[index + 2] === 0x43 && buffer[index + 3] === 0x46) offsets.push(index);
}
console.log(JSON.stringify({ offsets: offsets.slice(0, 10), count: offsets.length }));
if (offsets.length) {
  const start = offsets[offsets.length - 1];
  writeFileSync(out, buffer.subarray(start));
}
