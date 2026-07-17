import {readFile, rename, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {HNSW} from 'tinkerbird';
import {createTinyLmEmbedder} from './model-search.mjs';

export const VIDEO_SEARCH_SCHEMA_VERSION = 1;

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const limitValue = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 10;
};
const tokens = (value) => new Set(clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1));
const cosine = (left, right) => {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
};
const lexical = (query, text) => {
  const queryTokens = tokens(query);
  const textTokens = tokens(text);
  if (!queryTokens.size) return 0;
  return [...queryTokens].filter((token) => textTokens.has(token)).length / queryTokens.size;
};
const asVector = (value) => {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error('Video embedding provider returned an invalid vector.');
  }
  const vector = Array.from(value, Number);
  if (!vector.length || vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error('Video embedding provider returned an invalid vector.');
  }
  return vector;
};
const embedBatch = async (embedder, texts) => {
  const result = await embedder.embed(texts);
  const vectors = Array.isArray(result?.data)
    ? result.data.map((entry) => entry.embedding)
    : result;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`Video embedding provider returned ${vectors?.length || 0} vectors for ${texts.length} texts.`);
  }
  return vectors.map(asVector);
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJsonAtomically = async (path, payload) => {
  await mkdir(dirname(path), {recursive: true});
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(temporaryPath, path);
};

export const createVideoSearchAdapter = ({
  indexPath,
  embedder = createTinyLmEmbedder(),
  hnswClass = HNSW,
} = {}) => {
  if (!indexPath) throw new Error('A video search index path is required.');
  let loadedState = null;
  let writePromise = Promise.resolve();

  const serializeRecords = (records, index, dimensions) => ({
    schemaVersion: VIDEO_SEARCH_SCHEMA_VERSION,
    embeddingModel: embedder.model,
    dimensions,
    indexedAt: new Date().toISOString(),
    records,
    hnsw: index.serialize(),
  });

  const buildState = async (records) => {
    const normalizedRecords = records
      .map((record) => ({
        ...record,
        id: clean(record.id),
        searchText: clean(record.searchText || `${record.videoName || ''}. ${record.annotation || ''}`),
      }))
      .filter((record) => record.id && record.searchText);
    const vectors = normalizedRecords.length ? await embedBatch(embedder, normalizedRecords.map((record) => record.searchText)) : [];
    const index = new hnswClass();
    const dimensions = vectors[0]?.length || 0;
    for (let indexNumber = 0; indexNumber < vectors.length; indexNumber += 1) {
      if (!Array.isArray(vectors[indexNumber]) || vectors[indexNumber].length !== dimensions) throw new Error('Video annotation embedding dimensions changed.');
      await index.addVector(indexNumber, vectors[indexNumber], JSON.stringify(normalizedRecords[indexNumber]));
    }
    return {index, records: normalizedRecords, dimensions, embeddingModel: embedder.model, indexedAt: new Date().toISOString()};
  };

  const load = async () => {
    if (loadedState) return loadedState;
    try {
      const payload = await readJson(indexPath);
      if (payload.schemaVersion !== VIDEO_SEARCH_SCHEMA_VERSION) throw new Error('The video search index schema version is not supported.');
      const serialized = payload.hnsw || {};
      const records = Array.isArray(payload.records) ? payload.records : [];
      const serializedNodes = serialized.nodes || serialized.node || [];
      if (records.length && (!payload.dimensions || serializedNodes.length !== records.length)) {
        loadedState = await buildState(records);
        await persist(loadedState);
        return loadedState;
      }
      loadedState = {
        index: hnswClass.deserialize({...serialized, nodes: serializedNodes}),
        records,
        dimensions: payload.dimensions || 0,
        embeddingModel: payload.embeddingModel || embedder.model,
        indexedAt: payload.indexedAt || null,
      };
      return loadedState;
    } catch (error) {
      if (error?.code === 'ENOENT') return buildState([]);
      throw error;
    }
  };

  const persist = async (state) => {
    await writeJsonAtomically(indexPath, serializeRecords(state.records, state.index, state.dimensions));
  };

  const upsert = async (records) => {
    const current = await load();
    const merged = new Map(current.records.map((record) => [record.id, record]));
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (record?.id) merged.set(record.id, record);
    });
    const next = await buildState([...merged.values()]);
    loadedState = next;
    writePromise = writePromise.then(() => persist(next));
    await writePromise;
    return {indexedCount: next.records.length, updatedCount: records?.length || 0, indexedAt: next.indexedAt};
  };

  const search = async (query, {limit = 10, projectId = null} = {}) => {
    const normalizedQuery = clean(query);
    if (!normalizedQuery) throw new Error('A non-empty video search query is required.');
    const state = await load();
    if (!state.records.length) return {query: normalizedQuery, model: state.embeddingModel, results: []};
    const [queryVector] = await embedBatch(embedder, [normalizedQuery]);
    if (state.dimensions && queryVector.length !== state.dimensions) throw new Error('Video query embedding dimensions do not match the index.');
    // TinkerBird supplies the approximate-neighbor pass; exact reranking keeps
    // project filtering and small local corpora deterministic.
    if (state.records.length > 2) {
      state.index.query(queryVector, Math.min(state.records.length, Math.max(limitValue(limit) * 5, 20)));
    }
    const results = state.records.map((record, index) => ({
      ...record,
      semanticScore: cosine(queryVector, Array.from(state.index.nodes.get(index)?.embedding || [])),
      lexicalScore: lexical(normalizedQuery, record.searchText),
    }))
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => ({...record, score: record.semanticScore * 0.8 + record.lexicalScore * 0.2}))
      .filter((record) => record.score > 0)
      .sort((left, right) => right.score - left.score || left.time - right.time)
      .slice(0, limitValue(limit));
    return {query: normalizedQuery, model: state.embeddingModel, results};
  };

  const removeVideo = async (videoAssetId) => {
    const state = await load();
    const next = await buildState(state.records.filter((record) => record.videoAssetId !== videoAssetId));
    loadedState = next;
    await persist(next);
    return {indexedCount: next.records.length};
  };

  const status = async () => {
    const state = loadedState || await load();
    return {ready: Boolean(state), model: state.embeddingModel, dimensions: state.dimensions, recordCount: state.records.length, indexedAt: state.indexedAt, indexPath};
  };

  return {upsert, search, removeVideo, status};
};
