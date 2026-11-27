import { FrameCollectionError, FrameUnresponsiveError } from './frame-error.js';
import { provenHiddenFrames } from './hidden-frames.js';
import { COOPERATION_ARM, COOPERATION_DISABLE, COOPERATION_READ } from './types.js';

export function validFrame(value) {
  if (!value || typeof value !== 'object') return false;
  return typeof value.document === 'string'
    && Number.isSafeInteger(value.revision)
    && Number.isSafeInteger(value.structure)
    && Number.isSafeInteger(value.human)
    && typeof value.busy === 'boolean'
    && (value.pending === undefined || typeof value.pending === 'boolean')
    && (value.scrolling === undefined || typeof value.scrolling === 'boolean')
    && typeof value.editing === 'boolean'
    && typeof value.lastInput === 'number'
    && Array.isArray(value.fields) && value.fields.length <= 64
    && Array.isArray(value.events) && value.events.length <= 64;
}

function missingReceiver(error) {
  return error instanceof Error && error.message.includes('Receiving end does not exist');
}

export function frameIdentity(frame) {
  let url = '[unavailable]';
  try {
    const parsed = new URL(frame.url);
    url = ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.origin}${parsed.pathname}` : parsed.protocol;
  } catch { /* diagnostic formatting only */ }
  return { frame_id: frame.frameId, url };
}

export async function readFrame(tabId, frame, message, repairs) {
  const { kind } = message;
  let timer;
  let active = true;
  try {
    const request = () => chrome.tabs.sendMessage(tabId, message, { documentId: frame.documentId });
    const value = await Promise.race([
      (async () => {
        let first;
        try {
          first = await request();
        } catch (error) {
          if (!active || !missingReceiver(error)) throw error;
          if (kind === COOPERATION_DISABLE) throw new FrameCollectionError('frame_unobservable', [frameIdentity(frame)]);
          let repair = repairs.get(frame.documentId);
          if (!repair) {
            repair = chrome.scripting.executeScript({
              target: { tabId, documentIds: [frame.documentId] },
              files: ['content-scripts/cooperation.js'],
              injectImmediately: true,
            }).then(() => {});
            repairs.set(frame.documentId, repair);
          }
          try {
            await repair;
          } catch {
            throw new FrameCollectionError('frame_unobservable', [frameIdentity(frame)]);
          }
          if (!active) return undefined;
          try {
            first = await request();
          } catch (error) {
            if (!missingReceiver(error)) throw error;
            throw new FrameCollectionError('frame_unobservable', [frameIdentity(frame)]);
          }
        }
        if (first !== undefined || ![COOPERATION_READ, COOPERATION_ARM].includes(kind)) return first;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return active ? request() : undefined;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new FrameUnresponsiveError([frameIdentity(frame)])), 1200); }),
    ]);
    if (!validFrame(value)) throw new Error(`Interaction collection is unavailable in frame ${frame.frameId} (${value === undefined ? 'no reply' : 'invalid state'})`);
    return value;
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

export async function collectCooperationFrames(tabId, kind, lease, input, repairs = new Map(), hidden = new Set(), replacementPass = false) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const documents = new Set(frames?.map((frame) => frame.documentId));
  for (const documentId of repairs.keys()) if (!documents.has(documentId)) repairs.delete(documentId);
  for (const documentId of hidden) if (!documents.has(documentId)) hidden.delete(documentId);
  if (!frames?.length) throw new Error('No observable document in this tab');
  const gaps = [];
  const live = frames.filter((frame) => {
    if (frame.errorOccurred) {
      if (frame.frameId === 0) throw new FrameCollectionError('page_load_failed', [frameIdentity(frame)]);
      gaps.push({ ...frameIdentity(frame), reason: 'load_error' });
      return false;
    }
    if (frame.documentLifecycle && frame.documentLifecycle !== 'active') {
      gaps.push({ ...frameIdentity(frame), reason: 'inactive_document' });
      return false;
    }
    return true;
  });
  const remembered = kind === COOPERATION_DISABLE ? [] : live.filter((frame) => frame.frameId !== 0 && hidden.has(frame.documentId));
  const skipped = remembered.length ? await provenHiddenFrames(tabId, frames, remembered) : new Set();
  for (const frame of remembered) if (!skipped.has(frame.frameId)) hidden.delete(frame.documentId);
  const targets = live.filter((frame) => !skipped.has(frame.frameId));
  const message = { kind, lease, ...(input ? { input } : {}) };
  const results = await Promise.allSettled(targets.map(async (frame) => [frame.frameId, await readFrame(tabId, frame, message, repairs)]));
  const states = new Map();
  for (const result of results) {
    if (result.status === 'fulfilled') states.set(result.value[0], result.value[1]);
    else if (result.reason instanceof FrameCollectionError || result.reason instanceof FrameUnresponsiveError) throw result.reason;
    else throw result.reason;
  }
  return { frames: states, gaps };
}
