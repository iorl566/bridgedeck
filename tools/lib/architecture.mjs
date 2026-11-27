import fs from 'node:fs';
import path from 'node:path';

const IMPORT_RE = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

export function listSourceFiles(root = 'extension/src') {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full.split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

export function dependencyGraph(root = 'extension/src') {
  const files = listSourceFiles(root);
  const set = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const deps = [];
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const resolved = path.normalize(path.join(path.dirname(file), spec)).split(path.sep).join('/');
      if (set.has(resolved)) deps.push(resolved);
    }
    graph.set(file, deps);
  }
  return graph;
}

export function findCycles(graph) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const walk = (node) => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index >= 0) cycles.push([...stack.slice(index), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const dep of graph.get(node) || []) walk(dep);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) walk(node);
  return cycles;
}

export function fileLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}
