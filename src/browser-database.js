export const PROJECT_DATABASE_NAME = 'prismflow.project';
export const PROJECT_DATABASE_VERSION = 3;
export const PROJECT_STORE_NAME = 'projects';
export const ASSET_STORE_NAME = 'assets';
export const MODEL_PRICING_STORE_NAME = 'modelPricing';
export const VIDEO_FRAME_STORE_NAME = 'videoFrames';
export const VIDEO_FRAME_MANIFEST_STORE_NAME = 'videoFrameManifests';

const CURRENT_PROJECT_ID = 'current';

const hasIndexedDb = (indexedDBApi) => Boolean(indexedDBApi && typeof indexedDBApi.open === 'function');
const hasStoragePersistence = (storageApi) => Boolean(storageApi && typeof storageApi.persist === 'function');

export const createBrowserDatabase = ({
  indexedDBApi = globalThis.indexedDB,
  storageApi = globalThis.navigator?.storage,
} = {}) => {
  let databasePromise = null;

  const open = () => {
    if (!hasIndexedDb(indexedDBApi)) return Promise.resolve(null);
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBApi.open(PROJECT_DATABASE_NAME, PROJECT_DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
            database.createObjectStore(PROJECT_STORE_NAME, {keyPath: 'id'});
          }
          if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) {
            database.createObjectStore(ASSET_STORE_NAME, {keyPath: 'id'});
          }
          if (!database.objectStoreNames.contains(MODEL_PRICING_STORE_NAME)) {
            database.createObjectStore(MODEL_PRICING_STORE_NAME, {keyPath: 'id'});
          }
          if (!database.objectStoreNames.contains(VIDEO_FRAME_STORE_NAME)) {
            const store = database.createObjectStore(VIDEO_FRAME_STORE_NAME, {keyPath: 'id'});
            store.createIndex('videoAssetId', 'videoAssetId', {unique: false});
          } else {
            const store = request.transaction.objectStore(VIDEO_FRAME_STORE_NAME);
            if (!store.indexNames.contains('videoAssetId')) store.createIndex('videoAssetId', 'videoAssetId', {unique: false});
          }
          if (!database.objectStoreNames.contains(VIDEO_FRAME_MANIFEST_STORE_NAME)) {
            database.createObjectStore(VIDEO_FRAME_MANIFEST_STORE_NAME, {keyPath: 'id'});
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('PrismFlow database could not open.'));
      });
    }
    return databasePromise;
  };

  const run = async (storeName, mode, operation) => {
    const database = await open();
    if (!database) return null;

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      transaction.oncomplete = () => resolve(request?.result ?? null);
      transaction.onerror = () => reject(transaction.error || new Error('PrismFlow database transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('PrismFlow database transaction aborted.'));
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
      }
    });
  };

  return {
    async requestPersistence() {
      if (!hasStoragePersistence(storageApi)) return false;
      try {
        return Boolean(await storageApi.persist());
      } catch {
        return false;
      }
    },

    async loadProject() {
      const record = await run(PROJECT_STORE_NAME, 'readonly', (store) => store.get(CURRENT_PROJECT_ID));
      return record?.project || null;
    },

    async saveProject(project) {
      await run(PROJECT_STORE_NAME, 'readwrite', (store) => store.put({id: CURRENT_PROJECT_ID, project}));
    },

    async putAsset(assetId, blob) {
      if (!assetId || !blob) return;
      await run(ASSET_STORE_NAME, 'readwrite', (store) => store.put({id: assetId, blob}));
    },

    async getAsset(assetId) {
      if (!assetId) return null;
      const record = await run(ASSET_STORE_NAME, 'readonly', (store) => store.get(assetId));
      return record?.blob || null;
    },

    async removeAsset(assetId) {
      if (!assetId) return;
      await run(ASSET_STORE_NAME, 'readwrite', (store) => store.delete(assetId));
    },

    async putVideoFrame(frame) {
      if (!frame?.id || !frame.videoAssetId) return;
      await run(VIDEO_FRAME_STORE_NAME, 'readwrite', (store) => store.put(frame));
    },

    async getVideoFrames(videoAssetId) {
      if (!videoAssetId) return [];
      const frames = await run(VIDEO_FRAME_STORE_NAME, 'readonly', (store) => {
        if (store.indexNames?.contains?.('videoAssetId')) return store.index('videoAssetId').getAll(videoAssetId);
        return store.getAll();
      });
      return (Array.isArray(frames) ? frames : []).filter((frame) => frame.videoAssetId === videoAssetId);
    },

    async removeVideoFrames(videoAssetId) {
      if (!videoAssetId) return;
      const frames = await this.getVideoFrames(videoAssetId);
      if (frames.length) {
        await run(VIDEO_FRAME_STORE_NAME, 'readwrite', (store) => {
          frames.forEach((frame) => store.delete(frame.id));
        });
      }
      await run(VIDEO_FRAME_MANIFEST_STORE_NAME, 'readwrite', (store) => store.delete(videoAssetId));
    },

    async putVideoFrameManifest(manifest) {
      if (!manifest?.id) return;
      await run(VIDEO_FRAME_MANIFEST_STORE_NAME, 'readwrite', (store) => store.put(manifest));
    },

    async getVideoFrameManifest(videoAssetId) {
      if (!videoAssetId) return null;
      return run(VIDEO_FRAME_MANIFEST_STORE_NAME, 'readonly', (store) => store.get(videoAssetId));
    },

    async listVideoFrameManifests() {
      const manifests = await run(VIDEO_FRAME_MANIFEST_STORE_NAME, 'readonly', (store) => store.getAll());
      return Array.isArray(manifests) ? manifests : [];
    },

    async replaceModelPricing(records) {
      const database = await open();
      if (!database) return;
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(MODEL_PRICING_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(MODEL_PRICING_STORE_NAME);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Model pricing transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Model pricing transaction aborted.'));
        try {
          store.clear();
          (Array.isArray(records) ? records : []).forEach((record) => {
            if (record?.id) store.put(record);
          });
        } catch (error) {
          reject(error);
        }
      });
    },

    async loadModelPricing() {
      const records = await run(MODEL_PRICING_STORE_NAME, 'readonly', (store) => store.getAll());
      return Array.isArray(records) ? records : [];
    },
  };
};
