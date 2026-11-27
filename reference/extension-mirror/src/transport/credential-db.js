/** Extension-origin IndexedDB shared by local and remote credentials. */
export function openCredentialDatabase(factory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new Error('Credential storage is unavailable'));
      return;
    }
    const request = factory.open('bb-remote-authorization', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['connection', 'local', 'migration']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onerror = () => reject(new Error('Credential storage is unavailable'));
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Credential storage is blocked'));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      }
    };
  });
}
