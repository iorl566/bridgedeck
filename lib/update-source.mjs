// lib/update-source.mjs —— 发布清单来源（HTTPS / 本机 HTTP），零依赖。
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const DOMESTIC_MANIFEST_URL = 'https://download.bridgedeck.dev/stable/release.json';
export const GITHUB_MANIFEST_URL = 'https://github.com/iorl566/bridgedeck/releases/latest/download/release.json';

/**
 * Fetch the first working manifest and keep every failed source in the error.
 *
 * @param {Array<{ name: string, url: string }>} sources Ordered candidates.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ manifest: object, source: string, name: string }>}
 */
export async function fetchManifestWithFallback(sources, options = {}) {
  const failures = [];
  for (const source of sources) {
    try {
      const manifest = await fetchManifest(source.url, options);
      return { manifest, source: source.url, name: source.name };
    } catch (error) {
      failures.push(source.name + ' (' + source.url + '): ' + ((error && error.message) || error));
    }
  }
  throw new Error('所有更新源均失败：\n' + failures.join('\n'));
}

export function isAllowedSource(source) {
  let url;
  try {
    url = new URL(String(source || ''));
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return true;
  return false;
}

export function fetchManifest(source, { timeoutMs = 10000, maxBytes = MAX_MANIFEST_BYTES } = {}) {
  if (!isAllowedSource(source)) {
    return Promise.reject(new Error('发布源必须是 https，或本机 http://127.0.0.1 / localhost'));
  }
  const url = new URL(String(source));
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('拉取发布清单超时（' + timeoutMs + 'ms）')), timeoutMs);
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        finish(null, fetchManifest(new URL(res.headers.location, url).toString(), { timeoutMs, maxBytes }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error('发布源返回 HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          finish(new Error('发布清单超过 ' + maxBytes + ' 字节上限'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          finish(new Error('发布清单不是合法 JSON：' + error.message));
        }
      });
      res.on('error', (error) => finish(error));
    });
    req.on('error', (error) => finish(error));
  });
}

/** 下载发布 artifact（同样限制 https / loopback 与大小上限）。 */
export function fetchArtifact(source, { timeoutMs = 30000, maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!isAllowedSource(source)) {
    return Promise.reject(new Error('artifact 源必须是 https，或本机 http://127.0.0.1 / localhost'));
  }
  const url = new URL(String(source));
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('下载 artifact 超时（' + timeoutMs + 'ms）')), timeoutMs);
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        finish(null, fetchArtifact(new URL(res.headers.location, url).toString(), { timeoutMs, maxBytes }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error('artifact 返回 HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          finish(new Error('artifact 超过 ' + maxBytes + ' 字节上限'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', (error) => finish(error));
    });
    req.on('error', (error) => finish(error));
  });
}
