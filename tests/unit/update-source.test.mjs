import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchArtifact, fetchManifest, isAllowedSource } from '../../lib/update-source.mjs';

test('source allowlist accepts https and loopback http only', () => {
  assert.equal(isAllowedSource('https://example.com/release.json'), true);
  assert.equal(isAllowedSource('http://127.0.0.1:1234/release.json'), true);
  assert.equal(isAllowedSource('http://localhost:1234/release.json'), true);
  assert.equal(isAllowedSource('http://example.com/release.json'), false);
  assert.equal(isAllowedSource('ftp://example.com/release.json'), false);
});

test('fetchManifest parses JSON from loopback HTTP', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '0.1.1', artifacts: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const manifest = await fetchManifest('http://127.0.0.1:' + port + '/release.json');
    assert.equal(manifest.version, '0.1.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fetchArtifact downloads loopback bytes', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('artifact-bytes'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const buffer = await fetchArtifact('http://127.0.0.1:' + port + '/a.bin');
    assert.equal(buffer.toString('utf8'), 'artifact-bytes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
