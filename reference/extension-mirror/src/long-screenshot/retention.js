export const SCREENSHOT_HISTORY_LIMIT = 5;
export const SCREENSHOT_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
const POPUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep recent popup captures and exempt any still in use. Agent exports have a
 * separate lifecycle. Query current ownership only when about to delete a directory.
 * @param {(id: string) => boolean | Promise<boolean>} keep True when the caller still needs the capture.
 * @param {number} [now] Reference time in milliseconds.
 * @param {{ root?: object, read?: (id: string) => Promise<object> }} [deps] Storage overrides.
 * @returns {Promise<void>}
 */
export async function pruneScreenshots(keep, now = Date.now(), deps = {}) {
  const root = deps.root ?? await (await import('./tiles.js')).screenshotRoot();
  const read = deps.read ?? (async (id) => (await (await import('./tiles.js')).readTiledScreenshot(id)));
  const entries = [];
  for await (const [id, handle] of root.entries()) {
    if (handle.kind !== 'directory' || !POPUP_ID.test(id)) continue;
    try {
      const shot = await read(id);
      entries.push({ id, createdAt: Number.isFinite(shot?.createdAt) ? shot.createdAt : 0 });
    } catch (error) {
      if (error instanceof SyntaxError) entries.push({ id, createdAt: 0 });
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let retained = 0;
  let failure;
  for (const { id, createdAt } of entries) {
    if (createdAt > now - SCREENSHOT_HISTORY_AGE_MS && retained < SCREENSHOT_HISTORY_LIMIT) {
      retained += 1;
      continue;
    }
    try {
      if (await keep(id)) continue;
      await root.removeEntry(id, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) failure ??= error;
    }
  }
  if (failure) throw failure;
}
