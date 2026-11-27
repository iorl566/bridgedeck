import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';

/** Chrome may also start built-in extension workers named background.js. Match the fixture manifest. */
export async function attachVideoBackground(send, name) {
  let found;
  await expect.poll(async () => {
    const { targetInfos } = await send('Target.getTargets');
    for (const target of targetInfos) {
      if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension://')) continue;
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const reply = await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
        if (reply.result.value === name) {
          found = { sessionId, origin: target.url.split('/').slice(0, 3).join('/') };
          return true;
        }
      } finally {
        if (found?.sessionId !== sessionId) await send('Target.detachFromTarget', { sessionId });
      }
    }
    return false;
  }, { timeout: 15_000, message: `Wait for extension background: ${name}` }).toBe(true);
  return found;
}

/** Evidence is best effort: its failure must never replace the regression's result. */
export async function saveVideoEvidence(name, details, video) {
  const directory = process.env.BB_VIDEO_ARTIFACTS;
  if (!directory) return;
  try {
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${name}.mp4`);
    if (typeof video === 'function') await writeFile(destination, await video());
    else if (typeof video === 'string') await copyFile(video, destination);
    else if (video) await writeFile(destination, video);
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(details, null, 2));
  } catch (error) {
    console.warn(`Could not save video evidence ${name}:`, error);
  }
}
