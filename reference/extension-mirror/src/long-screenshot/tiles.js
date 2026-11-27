/**
 * Disk-backed tiled capture.
 * @typedef {object} TiledScreenshot
 * @property {'tiles'} kind Storage discriminator.
 * @property {string} id Capture identity.
 * @property {string} title Document title.
 * @property {number} createdAt Creation time in milliseconds.
 * @property {number} width Pixel width.
 * @property {number} height Pixel height.
 * @property {number} tileHeight Working-buffer height.
 * @property {number} bytes Approximate stored size.
 * @property {import('./types.js').CaptureError} [notice] Non-fatal warning saved with the manifest.
 */

/** Working-buffer height, not a limit on the final image. */
export const TILE_HEIGHT = 512;
/** Root directory that holds every saved capture. */
export const SCREENSHOT_ROOT = 'long-screenshots';

/**
 * @param {boolean} [create] Create the root when missing.
 * @param {object} [storage] Storage manager surface, defaults to the document's.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function screenshotRoot(create = false, storage = globalThis.navigator?.storage) {
  if (!storage?.getDirectory) throw new Error('screenshot storage unavailable');
  return (await storage.getDirectory()).getDirectoryHandle(SCREENSHOT_ROOT, { create });
}

/**
 * @param {string} id Capture identity.
 * @param {boolean} [create] Create the capture directory when missing.
 * @param {object} [storage] Storage manager surface.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function screenshotDirectory(id, create = false, storage) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid screenshot id');
  const root = await screenshotRoot(create, storage);
  return root.getDirectoryHandle(id, { create });
}

/**
 * @param {FileSystemDirectoryHandle} directory Capture directory.
 * @param {string} name File name inside it.
 * @param {Blob | string | Uint8Array} data File contents.
 * @returns {Promise<void>}
 */
export async function writeFile(directory, name, data) {
  const file = await directory.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(data);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

/**
 * @param {string} id Capture identity.
 * @param {object} [storage] Storage manager surface.
 * @param {(id: string) => Promise<TiledScreenshot>} [read] Manifest reader.
 * @returns {Promise<TiledScreenshot | undefined>} Manifest, or undefined when it does not exist.
 */
export async function readTiledScreenshot(id, storage, read = defaultRead) {
  try {
    return await read(id);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

async function defaultRead(id) {
  const directory = await screenshotDirectory(id);
  const file = await (await directory.getFileHandle('index.json')).getFile();
  return JSON.parse(await file.text());
}

/**
 * @param {string} id Capture identity.
 * @param {object} [storage] Storage manager surface.
 * @returns {Promise<void>}
 */
export async function removeTiledScreenshot(id, storage) {
  const root = await screenshotRoot(false, storage);
  await root.removeEntry(id, { recursive: true });
}

/**
 * @param {TiledScreenshot} shot Capture manifest.
 * @param {number} index Tile index.
 * @param {boolean} [preview] Prefer the downscaled preview image.
 * @param {object} [storage] Storage manager surface.
 * @returns {Promise<File>} Tile file inside the capture directory.
 */
export async function readTile(shot, index, preview = false, storage) {
  const directory = await screenshotDirectory(shot.id, false, storage);
  return (await directory.getFileHandle(`${index}${preview && shot.width > 1200 ? '.preview' : ''}.png`)).getFile();
}

/** A disk-backed image. Only the incoming viewport and one small tile are decoded. */
export class TileWriter {
  /**
   * @param {string} id Capture identity.
   * @param {string} title Document title.
   * @param {() => number} [now] Clock override for the manifest timestamp.
   */
  constructor(id, title, now = Date.now) {
    this.shot = { kind: 'tiles', id, title, createdAt: now(), width: 0, height: 0, tileHeight: TILE_HEIGHT, bytes: 0 };
    this.sizes = new Map();
    this.directory = undefined;
  }

  /**
   * Persist the manifest once a height exists.
   * @param {import('./types.js').CaptureError} [notice] Non-fatal warning to record.
   * @param {(directory: FileSystemDirectoryHandle, name: string, data: string) => Promise<void>} [write] Manifest writer.
   * @returns {Promise<void>}
   */
  async finish(notice, write = writeFile) {
    if (!this.directory || !this.shot.height) return;
    const next = { ...this.shot, notice };
    await write(this.directory, 'index.json', JSON.stringify(next));
    Object.assign(this.shot, next);
  }
}
