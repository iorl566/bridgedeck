// cli/commands/files.mjs —— download 命令（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';
import { ArgError } from '../lib/args.mjs';
import { formatBytes } from '../lib/format.mjs';

export async function downloadCommand(ctx, flags, pos) {
  const { withControl, resolveTarget, callRpc, timeoutOf, outputFailure, outputJsonBody, print, emitJson, readTransferToFile, isJson, BridgeError } = ctx;
  const params = withControl(flags, {});
  const target = resolveTarget(flags, pos, 1, { required: false });
  if (target) Object.assign(params, target);
  else if (flags.url !== undefined) params.url = String(flags.url);
  else throw new ArgError('download 需要 <ref|selector> 或 --url <url>');
  if (flags.timeout !== undefined) params.timeoutMs = Number(flags.timeout);
  const rpcTimeout = Math.max(timeoutOf(flags), (Number(params.timeoutMs) || 0) + 3000);
  const body = await callRpc('download', params, rpcTimeout);
  if (!body.ok) return outputFailure(body);
  const result = body.result || {};
  if (flags.out && result.filename) {
    const file = path.resolve(process.cwd(), String(flags.out));
    if (fs.existsSync(file) && flags.overwrite !== true) {
      throw new BridgeError('E_EXISTS', '目标文件已存在：' + file + '（加 --overwrite 覆盖）');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (result.transferId) {
        await readTransferToFile(result.transferId, file);
      } else {
        fs.copyFileSync(result.filename, file);
      }
      result.path = file;
    } catch (error) {
      throw new BridgeError('E_DOWNLOAD_FAILED', '写入下载文件失败：' + error.message);
    }
    if (result.transferId) {
      await callRpc('transfer.release', { transferId: result.transferId }, 10000).catch(() => {});
      result.transferReleased = true;
    }
  } else if (result.transferId) {
    await callRpc('transfer.release', { transferId: result.transferId }, 10000).catch(() => {});
    result.transferReleased = true;
  }
  if (isJson()) {
    if (result.filename) body.result.browserPath = result.filename;
    emitJson(body);
    return 0;
  }
  print('已下载：' + result.filename + '（' + formatBytes(result.bytes) + '）' + (result.path ? ' → ' + result.path : ''));
  if (result.path && result.filename && path.resolve(result.path) !== path.resolve(result.filename)) {
    print('浏览器保存路径：' + result.filename);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// v0.2：设置 / 借用标签页 / plan / step / view / 对话框 / 网络 / 仿真
// ---------------------------------------------------------------------------

export async function uploadCommand(ctx, flags, pos) {
  const { withControl, resolveTarget, callRpc, timeoutOf, renderPageBody, print, guessMime, stageUploadBuffer, ArgError } = ctx;
  const target = resolveTarget(flags, pos, 1, { required: true });
  const list = Array.isArray(flags.file) ? flags.file : (flags.file ? [flags.file] : []);
  if (!list.length) throw new ArgError('upload 需要至少一个 --file <path>');
  // 大文件走 daemon staging（transfer.*），避免把整文件塞进一次 JSON RPC；
  // 小文件保持内联 base64，保留隐藏 input 兜底能力。
  const STAGE_THRESHOLD = 4 * 1024 * 1024;
  let total = 0;
  const files = [];
  const paths = [];
  for (const entry of list) {
    const filePath = path.resolve(process.cwd(), String(entry));
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (error) {
      throw new ArgError('读取文件失败：' + filePath + '（' + error.message + '）');
    }
    total += buffer.length;
    const name = path.basename(filePath);
    const mime = guessMime(filePath);
    if (buffer.length > STAGE_THRESHOLD) {
      const transferId = await stageUploadBuffer(flags, buffer, name);
      const staged = { name, mime, transferId };
      // 8MB 以内保留内联副本，兼容直接给 input[type=file] 赋值/隐藏 input 兜底；
      // 更大的文件只走路径，避免单次 RPC 过大。
      if (buffer.length <= 8 * 1024 * 1024) staged.base64 = buffer.toString('base64');
      files.push(staged);
      paths.push(null);
    } else {
      files.push({ name, mime, base64: buffer.toString('base64') });
      paths.push(filePath);
    }
  }
  if (total > 20 * 1024 * 1024) throw new ArgError('上传总大小超过 20MB');
  const params = withControl(flags, { ...target, files, paths });
  if (flags.mode === 'drop') params.mode = 'drop';
  const body = await callRpc('upload', params, Math.max(timeoutOf(flags), 120000));
  return renderPageBody(body, (result) => {
    print('已填入：' + (result.names || []).join(', '));
  });
}


