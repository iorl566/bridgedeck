// lib/recipe-store.mjs —— recipe 持久化、审批校验与参数替换（零依赖）。
//
// recipe 是“已审阅的固定动作序列”：草稿默认不可执行；approve 写入
// stepsHash + expiresAt，run 前重新计算哈希，防止审批后被篡改。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RECIPE_TTL_MS = 24 * 60 * 60 * 1000;

export class RecipeStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecipeStoreError';
    this.code = code;
  }
}

export function sanitizeRecipeName(name) {
  const safe = String(name || '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60);
  if (!safe) throw new RecipeStoreError('E_BAD_ARG', 'recipe 名称不合法');
  return safe;
}

export function recipePath(dir, name) {
  return path.join(dir, sanitizeRecipeName(name) + '.json');
}

export function recipeStepsHash(steps) {
  return crypto.createHash('sha256').update(JSON.stringify(steps || [])).digest('hex');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
}

export function readRecipe(dir, name) {
  const file = recipePath(dir, name);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new RecipeStoreError('E_NOT_FOUND', 'recipe 不存在：' + file);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RecipeStoreError('E_BAD_JSON', 'recipe 不是合法 JSON：' + file);
  }
}

export function saveRecipe(dir, name, input) {
  if (!Array.isArray(input && input.steps) || input.steps.length === 0) {
    throw new RecipeStoreError('E_BAD_ARG', 'recipe 需要非空 steps 数组');
  }
  const file = recipePath(dir, name);
  const recipe = {
    name: input.name || String(name),
    steps: input.steps,
    approved: false,
    createdAt: Date.now(),
    approvedAt: null,
    approver: '',
    stepsHash: null,
  };
  writeJsonAtomic(file, recipe);
  return { file, recipe };
}

export function listRecipes(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }
  return files.map((file) => {
    const target = path.join(dir, file);
    let title = '';
    let steps = 0;
    let broken = false;
    try {
      const json = JSON.parse(fs.readFileSync(target, 'utf8'));
      title = json.name || '';
      steps = Array.isArray(json.steps) ? json.steps.length : 0;
    } catch {
      title = '(损坏)';
      broken = true;
    }
    return { name: path.basename(file, '.json'), title, steps, file: target, broken };
  });
}

export function approveRecipe(dir, name, { approver, host, ttlMs = RECIPE_TTL_MS } = {}) {
  const file = recipePath(dir, name);
  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new RecipeStoreError('E_NOT_FOUND', '找不到 recipe：' + file);
  }
  recipe.approved = true;
  recipe.approvedAt = Date.now();
  recipe.approver = String(approver || 'human');
  recipe.approverHost = String(host || '');
  recipe.stepsHash = recipeStepsHash(recipe.steps);
  recipe.expiresAt = Date.now() + ttlMs;
  writeJsonAtomic(file, recipe);
  return recipe;
}

export function assertRunnable(recipe, now = Date.now()) {
  if (recipe.approved === false) {
    throw new RecipeStoreError('E_RECIPE_NOT_APPROVED', 'recipe 未审批：请人类执行 bridge recipe approve <name> --confirm-human');
  }
  if (recipe.expiresAt && now > Number(recipe.expiresAt)) {
    throw new RecipeStoreError('E_RECIPE_EXPIRED', 'recipe 审批已过期（24 小时），请重新审批：bridge recipe approve <name> --confirm-human');
  }
  if (recipe.stepsHash && recipe.stepsHash !== recipeStepsHash(recipe.steps)) {
    throw new RecipeStoreError('E_RECIPE_CHANGED', 'recipe 审批后内容已变更，请重新审批：bridge recipe approve <name> --confirm-human');
  }
  return true;
}

export function substituteParams(value, params) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new RecipeStoreError('E_BAD_ARG', 'recipe 缺少参数 {{' + key + '}}（用 --param ' + key + '=值 传入）');
      }
      return String(params[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteParams(item, params));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = substituteParams(value[key], params);
    return out;
  }
  return value;
}
