#!/usr/bin/env node
// crates/bridge-cli/scripts/gen-error-codes.mjs —— Rust 侧协议常量的唯一生成器。
//
// 单源（只读）：
//   - lib/error-codes.mjs      → ERROR_CODES（154 码）+ ERROR_RECOVERY（恢复建议）
//   - lib/method-catalog.mjs   → FEATURE_FLOORS / FEATURE_META / METHOD_CATALOG /
//                                PROTOCOL_BASELINE / PROTOCOL_CURRENT
//   - package.json             → PRODUCT_VERSION
//
// 产出（禁止手改）：
//   - crates/bridge-cli/src/generated/error_codes.rs
//   - crates/bridge-cli/src/generated/protocol_catalog.rs
//
// 用法：
//   node crates/bridge-cli/scripts/gen-error-codes.mjs          # 重新生成
//   node crates/bridge-cli/scripts/gen-error-codes.mjs --check  # 漂移校验（不写文件；漂移 exit 1）
//
// 约束：本脚本只读取 JS 单源并写 crates/bridge-cli/src/generated/**，不引入任何第三方包。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const crateDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(crateDir, '..', '..');
const generatedDir = path.join(crateDir, 'src', 'generated');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
for (const arg of args) {
  if (arg !== '--check') {
    console.error(`未知参数：${arg}（仅支持 --check）`);
    process.exit(2);
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadSources() {
  const errorCodesUrl = pathToFileURL(path.join(repoRoot, 'lib', 'error-codes.mjs')).href;
  const catalogUrl = pathToFileURL(path.join(repoRoot, 'lib', 'method-catalog.mjs')).href;
  const pkgUrl = pathToFileURL(path.join(repoRoot, 'package.json')).href;
  const errorCodes = await import(errorCodesUrl);
  const catalog = await import(catalogUrl);
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(pkgUrl), 'utf8'));
  return { errorCodes, catalog, pkg };
}

/** JS 字符串 → Rust 字符串字面量（保留非 ASCII 原文，转义控制字符）。 */
function rustStr(value) {
  let out = '"';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\u{' + cp.toString(16) + '}';
    else out += ch;
  }
  return out + '"';
}

function rustOptStr(value) {
  return value === undefined || value === null ? 'None' : `Some(${rustStr(value)})`;
}

/** E_BAD_ARG → BadArg；E_EVAL_DOM_BAD_JSON → EvalDomBadJson。 */
function variantName(code) {
  const bare = code.startsWith('E_') ? code.slice(2) : code;
  const name = bare
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`错误码无法转成 Rust 变体名：${code}`);
  return name;
}

function ensureUnique(values, what) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${what} 重复：${value}（单源内部不一致，拒绝生成）`);
    seen.add(value);
  }
}

function renderErrorCodes({ errorCodes, errorSourceHash }) {
  const codes = Object.keys(errorCodes.ERROR_CODES);
  const recovery = errorCodes.ERROR_RECOVERY || {};
  const variants = codes.map((code) => ({ code, variant: variantName(code) }));
  ensureUnique(variants.map((item) => item.variant), 'Rust 错误码变体');
  // 恢复建议只能引用已登记的错误码，否则生成物会出现不可达分支。
  for (const code of Object.keys(recovery)) {
    if (!errorCodes.ERROR_CODES[code]) throw new Error(`ERROR_RECOVERY 引用了未登记的错误码：${code}`);
  }

  const lines = [];
  lines.push('//! 错误码（机器生成，禁止手改）。');
  lines.push('//!');
  lines.push('//! 单源：`lib/error-codes.mjs`（ERROR_CODES / ERROR_RECOVERY）。');
  lines.push('//! 生成器：`crates/bridge-cli/scripts/gen-error-codes.mjs`；漂移校验：`--check`。');
  lines.push(`//! 源文件 sha256：\`${errorSourceHash}\`。`);
  lines.push('');
  lines.push('#![allow(dead_code)]');
  lines.push('');
  lines.push('/// 协议错误码枚举；声明顺序与 `ERROR_CODES` 一致（CLI/daemon 共用字符串码）。');
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]');
  lines.push('pub enum ErrorCode {');
  for (const { code, variant } of variants) {
    lines.push(`    /// \`${code}\``);
    lines.push(`    ${variant},`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`/// 错误码总数（生成时固定，漂移由 --check 捕获）。`);
  lines.push(`pub const ERROR_CODE_COUNT: usize = ${codes.length};`);
  lines.push(`/// 登记了恢复建议的错误码数量。`);
  lines.push(`pub const ERROR_RECOVERY_COUNT: usize = ${Object.keys(recovery).length};`);
  lines.push('');
  lines.push('/// 恢复建议（对应 JS `ERROR_RECOVERY[code]`）。');
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq)]');
  lines.push('pub struct ErrorRecovery {');
  lines.push('    /// `no` / `transient` / `after-action`。');
  lines.push("    pub retry: &'static str,");
  lines.push('    /// 人类可读恢复提示（中文，与 CLI/插件共用）。');
  lines.push("    pub hint: &'static str,");
  lines.push('}');
  lines.push('');
  lines.push('impl ErrorCode {');
  lines.push(`    /// 全部错误码（${codes.length} 个），声明顺序。`);
  lines.push(`    pub const ALL: [ErrorCode; ${codes.length}] = [`);
  for (const { variant } of variants) lines.push(`        ErrorCode::${variant},`);
  lines.push('    ];');
  lines.push('');
  lines.push('    /// 规范字符串码（如 `E_BAD_ARG`）。');
  lines.push("    pub fn as_str(self) -> &'static str {");
  lines.push('        match self {');
  for (const { code, variant } of variants) lines.push(`            ErrorCode::${variant} => ${rustStr(code)},`);
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    /// 一句话含义（与 `lib/error-codes.mjs` 的注释同源）。');
  lines.push("    pub fn description(self) -> &'static str {");
  lines.push('        match self {');
  for (const { code, variant } of variants) {
    lines.push(`            ErrorCode::${variant} => ${rustStr(errorCodes.ERROR_CODES[code])},`);
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    /// 恢复建议；未登记返回 `None`（调用方按“不可自动重试”处理）。');
  lines.push('    pub fn recovery(self) -> Option<ErrorRecovery> {');
  lines.push('        match self {');
  for (const { code, variant } of variants) {
    const entry = recovery[code];
    if (!entry) continue;
    lines.push(
      `            ErrorCode::${variant} => Some(ErrorRecovery { retry: ${rustStr(entry.retry)}, hint: ${rustStr(entry.hint)} }),`,
    );
  }
  lines.push('            _ => None,');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    /// 字符串码 → 枚举；未知码返回 `None`（`normalize` 落到 `E_INTERNAL`）。');
  lines.push("    pub fn from_code(code: &str) -> Option<ErrorCode> {");
  lines.push('        match code {');
  for (const { code, variant } of variants) lines.push(`            ${rustStr(code)} => Some(ErrorCode::${variant}),`);
  lines.push('            _ => None,');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return {
    text: lines.join('\n'),
    stats: { codes: codes.length, recovery: Object.keys(recovery).length },
  };
}

function renderProtocolCatalog({ catalog, pkg, catalogSourceHash, pkgSourceHash }) {
  const features = catalog.FEATURE_NAMES.map((feature) => {
    const floor = catalog.FEATURE_FLOORS[feature];
    const meta = catalog.FEATURE_META[feature] || {};
    return {
      feature,
      floor,
      label: meta.label || feature,
      kind: meta.kind || 'method',
    };
  });
  ensureUnique(features.map((item) => item.feature), 'feature floor 名称');
  const methods = catalog.METHOD_CATALOG.map((row) => ({
    method: row.method,
    owner: row.owner,
    effect: row.effect,
    receipt: row.receipt === true,
    floor: row.floor === undefined ? null : row.floor,
    partial: row.partial === true,
    unknown: row.unknown === true,
    reconcile: row.reconcile && row.reconcile.strategy ? row.reconcile.strategy : 'none',
    reconcileMethod: row.reconcile && row.reconcile.method ? row.reconcile.method : null,
  }));
  ensureUnique(methods.map((item) => item.method), '方法名');
  if (methods.length !== catalog.METHOD_COUNT) {
    throw new Error(`METHOD_CATALOG 行数 ${methods.length} != METHOD_COUNT ${catalog.METHOD_COUNT}`);
  }

  const lines = [];
  lines.push('//! 协议目录（机器生成，禁止手改）。');
  lines.push('//!');
  lines.push('//! 单源：`lib/method-catalog.mjs`（方法目录 / feature floor / 协议基线）+ 根 `package.json` 版本。');
  lines.push('//! 生成器：`crates/bridge-cli/scripts/gen-error-codes.mjs`；漂移校验：`--check`。');
  lines.push(`//! method-catalog.mjs sha256：\`${catalogSourceHash}\`；package.json sha256：\`${pkgSourceHash}\`。`);
  lines.push('');
  lines.push('#![allow(dead_code)]');
  lines.push('');
  lines.push('/// 产品版本（来自根 `package.json`，不手写）。');
  lines.push(`pub const PRODUCT_VERSION: &str = ${rustStr(pkg.version || '0.0.0')};`);
  lines.push('/// 协议兼容基线：该版本客户端仍可连接，但会缺 1.9 特性门。');
  lines.push(`pub const PROTOCOL_BASELINE: &str = ${rustStr(catalog.PROTOCOL_BASELINE)};`);
  lines.push('/// 当前协议版本（daemon hello-ack / status 返回）。');
  lines.push(`pub const PROTOCOL_CURRENT: &str = ${rustStr(catalog.PROTOCOL_CURRENT)};`);
  const [major, minor] = String(catalog.PROTOCOL_CURRENT).split('.').map(Number);
  lines.push(`pub const PROTOCOL_MAJOR: u32 = ${major};`);
  lines.push(`pub const PROTOCOL_MINOR: u32 = ${minor};`);
  lines.push('');
  lines.push('/// feature floor：能力门 → 对端扩展至少需要的协议版本。');
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq)]');
  lines.push('pub struct FeatureSpec {');
  lines.push('    pub feature: &\'static str,');
  lines.push('    pub floor: &\'static str,');
  lines.push("    /// 人类可读标签。");
  lines.push('    pub label: &\'static str,');
  lines.push("    /// 触发方式：`param` / `method` / `method+param`。");
  lines.push('    pub kind: &\'static str,');
  lines.push('}');
  lines.push('');
  lines.push(`pub const FEATURE_FLOORS: &[FeatureSpec] = &[`);
  for (const item of features) {
    lines.push(
      `    FeatureSpec { feature: ${rustStr(item.feature)}, floor: ${rustStr(item.floor)}, label: ${rustStr(item.label)}, kind: ${rustStr(item.kind)} },`,
    );
  }
  lines.push('];');
  lines.push(`pub const FEATURE_COUNT: usize = ${features.length};`);
  lines.push('');
  lines.push('/// 方法目录（owner / effect / receipt / feature floor / partial / unknown / reconcile）。');
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq)]');
  lines.push('pub struct MethodSpec {');
  lines.push('    pub method: &\'static str,');
  lines.push('    pub owner: &\'static str,');
  lines.push('    pub effect: &\'static str,');
  lines.push('    pub receipt: bool,');
  lines.push('    pub floor: Option<&\'static str>,');
  lines.push('    pub partial: bool,');
  lines.push('    pub unknown: bool,');
  lines.push('    pub reconcile: &\'static str,');
  lines.push('    pub reconcile_method: Option<&\'static str>,');
  lines.push('}');
  lines.push('');
  lines.push('pub const METHOD_CATALOG: &[MethodSpec] = &[');
  for (const item of methods) {
    lines.push(
      '    MethodSpec { ' +
        `method: ${rustStr(item.method)}, owner: ${rustStr(item.owner)}, effect: ${rustStr(item.effect)}, ` +
        `receipt: ${item.receipt}, floor: ${rustOptStr(item.floor)}, partial: ${item.partial}, ` +
        `unknown: ${item.unknown}, reconcile: ${rustStr(item.reconcile)}, reconcile_method: ${rustOptStr(item.reconcileMethod)} },`,
    );
  }
  lines.push('];');
  lines.push(`pub const METHOD_COUNT: usize = ${methods.length};`);
  lines.push('');
  const byOwner = {};
  for (const item of methods) byOwner[item.owner] = (byOwner[item.owner] || 0) + 1;
  lines.push('/// owner 顺序 → 方法数（生成时固定，顺序稳定）。');
  lines.push('pub const OWNER_COUNTS: &[(&str, usize)] = &[');
  for (const [owner, count] of Object.entries(byOwner)) lines.push(`    (${rustStr(owner)}, ${count}),`);
  lines.push('];');
  lines.push('');
  const byEffect = {};
  for (const item of methods) byEffect[item.effect] = (byEffect[item.effect] || 0) + 1;
  lines.push('/// effect 顺序 → 方法数（生成时固定，顺序稳定）。');
  lines.push('pub const EFFECT_COUNTS: &[(&str, usize)] = &[');
  for (const [effect, count] of Object.entries(byEffect)) lines.push(`    (${rustStr(effect)}, ${count}),`);
  lines.push('];');
  lines.push('');
  return { text: lines.join('\n'), stats: { methods: methods.length, features: features.length } };
}

async function main() {
  const { errorCodes, catalog, pkg } = await loadSources();
  const errorSourcePath = path.join(repoRoot, 'lib', 'error-codes.mjs');
  const catalogSourcePath = path.join(repoRoot, 'lib', 'method-catalog.mjs');
  const pkgPath = path.join(repoRoot, 'package.json');
  const errorSourceHash = sha256(fs.readFileSync(errorSourcePath, 'utf8'));
  const catalogSourceHash = sha256(fs.readFileSync(catalogSourcePath, 'utf8'));
  const pkgSourceHash = sha256(fs.readFileSync(pkgPath, 'utf8'));

  const errors = renderErrorCodes({ errorCodes, errorSourceHash });
  const protocols = renderProtocolCatalog({ catalog, pkg, catalogSourceHash, pkgSourceHash });
  const outputs = [
    { file: path.join(generatedDir, 'error_codes.rs'), rel: 'src/generated/error_codes.rs', text: errors.text + '\n' },
    {
      file: path.join(generatedDir, 'protocol_catalog.rs'),
      rel: 'src/generated/protocol_catalog.rs',
      text: protocols.text + '\n',
    },
  ];

  if (checkOnly) {
    let drift = false;
    for (const output of outputs) {
      let actual = null;
      try {
        actual = fs.readFileSync(output.file, 'utf8');
      } catch {
        console.error(`gen-error-codes: --check 失败：缺少生成物 ${output.rel}`);
        drift = true;
        continue;
      }
      if (actual !== output.text) {
        drift = true;
        const expectedLines = output.text.split('\n');
        const actualLines = actual.split('\n');
        const max = Math.max(expectedLines.length, actualLines.length);
        let first = -1;
        for (let i = 0; i < max; i += 1) {
          if (expectedLines[i] !== actualLines[i]) {
            first = i;
            break;
          }
        }
        console.error(
          `gen-error-codes: --check 漂移 ${output.rel}（首个差异在第 ${first + 1} 行；` +
            `生成物 ${actualLines.length} 行，期望 ${expectedLines.length} 行）`,
        );
      }
    }
    if (drift) {
      console.error('gen-error-codes: 生成物与 JS 单源不一致；请运行 node crates/bridge-cli/scripts/gen-error-codes.mjs');
      process.exit(1);
    }
    console.log(
      `gen-error-codes: --check clean（${errors.stats.codes} 错误码 / ${errors.stats.recovery} 恢复建议 / ` +
        `${protocols.stats.methods} 方法 / ${protocols.stats.features} feature floors）`,
    );
    return;
  }

  fs.mkdirSync(generatedDir, { recursive: true });
  for (const output of outputs) {
    fs.writeFileSync(output.file, output.text, 'utf8');
    console.log(`gen-error-codes: 写入 ${output.rel}（${output.text.split('\n').length - 1} 行）`);
  }
  console.log(
    `gen-error-codes: ${errors.stats.codes} 错误码 / ${errors.stats.recovery} 恢复建议 / ` +
      `${protocols.stats.methods} 方法 / ${protocols.stats.features} feature floors（单源已同步）`,
  );
}

main().catch((error) => {
  console.error(`gen-error-codes: 失败：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
