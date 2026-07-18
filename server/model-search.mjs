import {readFile, rename, stat, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {HNSW} from 'tinkerbird';

export const MODEL_SEARCH_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_SEARCH_SCHEMA_VERSION = 1;

let tinyLmClassPromise;

const loadTinyLmClass = () => {
  tinyLmClassPromise ||= import('tinylm').then(({TinyLM}) => TinyLM);
  return tinyLmClassPromise;
};

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.35;
const LEXICAL_WEIGHT = 0.15;
const DESCRIPTION_WEIGHT = 0.15;
const INTENT_WEIGHT = 0.25;
const RARE_TERM_WEIGHT = 0.05;
const ENTITY_WEIGHT = 0.05;
const ENTITY_STOPWORDS = new Set(['audio', 'fast', 'generate', 'generated', 'generation', 'image', 'latest', 'model', 'new', 'text', 'to', 'video']);

const cleanText = (value) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim()
  : '';

const humanize = (value) => cleanText(value).replaceAll('-', ' ');

const apiUrlFor = (endpointId) => endpointId
  ? `https://fal.ai/models/${endpointId}/api`
  : null;

const metadataFor = (record) => record?.model?.metadata || {};

export const modelSearchText = (record) => {
  const metadata = metadataFor(record);
  const displayName = cleanText(metadata.display_name) || cleanText(record?.endpointId) || 'Unnamed model';
  const description = cleanText(metadata.description);
  return [displayName, description].filter(Boolean).join('. ');
};

const modelSearchRecord = (record) => {
  const metadata = metadataFor(record);
  const endpointId = cleanText(record?.endpointId) || cleanText(record?.id);
  const displayName = cleanText(metadata.display_name) || endpointId || 'Unnamed model';
  const description = cleanText(metadata.description);
  const category = cleanText(metadata.category);
  const group = cleanText(metadata.group?.label);
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.map(cleanText).filter(Boolean)
    : [];
  const text = modelSearchText(record);

  return {
    endpointId,
    displayName,
    description,
    category,
    group,
    tags,
    modelUrl: cleanText(metadata.model_url) || (endpointId ? `https://fal.run/${endpointId}` : null),
    apiUrl: apiUrlFor(endpointId),
    thumbnailUrl: cleanText(metadata.thumbnail_url) || null,
    prices: Array.isArray(record?.prices) ? record.prices : [],
    text,
    embeddingText: [
      text,
      category ? `Model type: ${humanize(category)}` : '',
      group ? `Model group: ${group}` : '',
      tags.length ? `Tags: ${tags.join(', ')}` : '',
    ].filter(Boolean).join('. '),
  };
};

export const buildModelSearchCorpus = (records) => (Array.isArray(records) ? records : [])
  .map(modelSearchRecord)
  .filter((record) => record.endpointId && record.text);

const normalizeLimit = (limit) => {
  const value = Number.parseInt(limit, 10);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value));
};

const asVector = (value) => {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error('Embedding provider returned an invalid vector.');
  }
  const vector = Array.from(value, Number);
  if (!vector.length || vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error('Embedding provider returned an invalid vector.');
  }
  return vector;
};

const cosineSimilarity = (left, right) => {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
};

const tokensFor = (value) => new Set(cleanText(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((token) => token.length > 1));

const documentFrequencyFor = (records) => {
  const frequencies = new Map();
  for (const record of records) {
    for (const token of tokensFor(record.embeddingText || record.text)) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
  }
  return frequencies;
};

const lexicalOverlap = (queryTokens, text, documentFrequency, documentCount) => {
  if (!queryTokens.size) return 0;
  const textTokens = tokensFor(text);
  let matches = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const inverseDocumentFrequency = Math.log(
      (documentCount + 1) / ((documentFrequency.get(token) || 0) + 1),
    ) + 1;
    totalWeight += inverseDocumentFrequency;
    if (textTokens.has(token)) matches += inverseDocumentFrequency;
  }
  return totalWeight ? matches / totalWeight : 0;
};

const categoryIntentMatch = (query, category) => {
  const normalizedQuery = cleanText(query).toLowerCase().replace(/[-_]+/g, ' ');
  const normalizedCategory = humanize(category).toLowerCase().replace(/[-_]+/g, ' ');
  return normalizedCategory && normalizedQuery.includes(normalizedCategory) ? 1 : 0;
};

const rareTermOverlap = (queryTokens, text, documentFrequency, documentCount) => {
  const textTokens = tokensFor(text);
  let matches = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const inverseDocumentFrequency = Math.log(
      (documentCount + 1) / ((documentFrequency.get(token) || 0) + 1),
    ) + 1;
    if (inverseDocumentFrequency < 3) continue;
    totalWeight += inverseDocumentFrequency;
    if (textTokens.has(token)) matches += inverseDocumentFrequency;
  }
  return totalWeight ? matches / totalWeight : 0;
};

const properNounTokensFor = (value) => new Set(
  [...cleanText(value).matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)]
    .filter((match) => {
      const prefix = cleanText(value.slice(0, match.index));
      return prefix && !/[.!?:]$/.test(prefix);
    })
    .map((match) => match[0].toLowerCase()),
);

const singularToken = (token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token;

const entityVocabularyFor = (records) => {
  const vocabulary = new Set();
  for (const record of records) {
    for (const token of properNounTokensFor(record.description)) vocabulary.add(token);
  }
  return vocabulary;
};

const entityOverlap = (queryTokens, text, vocabulary) => {
  const candidateTokens = [...queryTokens].filter((token) => {
    const normalizedToken = singularToken(token);
    return !ENTITY_STOPWORDS.has(normalizedToken)
      && (vocabulary.has(token) || vocabulary.has(normalizedToken));
  });
  if (!candidateTokens.length) return 0;
  const recordEntities = properNounTokensFor(text);
  const matches = candidateTokens.filter((token) => recordEntities.has(token) || recordEntities.has(singularToken(token))).length;
  return matches / candidateTokens.length;
};

const embedBatch = async (embedder, texts) => {
  const result = await embedder.embed(texts);
  const vectors = Array.isArray(result?.data)
    ? result.data.map((entry) => entry.embedding)
    : result;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`Embedding provider returned ${vectors?.length || 0} vectors for ${texts.length} texts.`);
  }
  return vectors.map(asVector);
};

export const createTinyLmEmbedder = ({
  model = MODEL_SEARCH_EMBEDDING_MODEL,
  progressCallback,
} = {}) => {
  let tinyPromise;

  const getTiny = () => {
    if (!tinyPromise) {
      tinyPromise = (async () => {
        const TinyLM = await loadTinyLmClass();
        const tiny = new TinyLM({progressCallback});
        await tiny.init({embeddingModels: [model], lazyLoad: false});
        return tiny;
      })();
    }
    return tinyPromise;
  };

  return {
    model,
    async embed(texts) {
      const tiny = await getTiny();
      return tiny.embeddings.create({
        model,
        input: texts,
        encoding_format: 'float',
      });
    },
  };
};

const readJsonFile = async (path) => JSON.parse(await readFile(path, 'utf8'));

const writeJsonFileAtomically = async (path, payload) => {
  await mkdir(dirname(path), {recursive: true});
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(temporaryPath, path);
};

export const createModelSearchAdapter = ({
  catalogPath,
  indexPath,
  embedder = createTinyLmEmbedder(),
  hnswClass = HNSW,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) => {
  if (!catalogPath) throw new Error('A model search catalog path is required.');
  if (!indexPath) throw new Error('A model search index path is required.');

  let loadedState = null;
  let buildPromise = null;

  const loadCatalog = async () => {
    const payload = await readJsonFile(catalogPath);
    const records = Array.isArray(payload) ? payload : payload.records;
    return buildModelSearchCorpus(records);
  };

  const loadIndex = async () => {
    if (loadedState) return loadedState;
    const payload = await readJsonFile(indexPath);
    if (payload.schemaVersion !== MODEL_SEARCH_SCHEMA_VERSION) {
      throw new Error('The model search index schema version is not supported.');
    }
    const serialized = payload.hnsw || {};
    const hnswData = {
      ...serialized,
      nodes: serialized.nodes || serialized.node || [],
    };
    const index = hnswClass.deserialize(hnswData);
    loadedState = {
      index,
      records: Array.isArray(payload.records) ? payload.records : [],
      documentFrequency: documentFrequencyFor(Array.isArray(payload.records) ? payload.records : []),
      entityVocabulary: entityVocabularyFor(Array.isArray(payload.records) ? payload.records : []),
      dimensions: payload.dimensions || index.d,
      embeddingModel: payload.embeddingModel || embedder.model || MODEL_SEARCH_EMBEDDING_MODEL,
      indexedAt: payload.indexedAt || null,
    };
    return loadedState;
  };

  const ensureLoaded = async () => {
    if (loadedState) return loadedState;
    try {
      return await loadIndex();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const missing = new Error('The model search index is not built. Run `npm run search:index` first.');
        missing.statusCode = 503;
        throw missing;
      }
      throw error;
    }
  };

  const buildIndex = async () => {
    if (buildPromise) return buildPromise;
    buildPromise = (async () => {
      const records = await loadCatalog();
      if (!records.length) throw new Error('The model search catalog is empty.');

      const index = new hnswClass();
      let dimensions = null;
      for (let start = 0; start < records.length; start += batchSize) {
        const batch = records.slice(start, start + batchSize);
        const vectors = await embedBatch(embedder, batch.map((record) => record.embeddingText));
        for (let offset = 0; offset < vectors.length; offset += 1) {
          const vector = vectors[offset];
          dimensions ??= vector.length;
          if (vector.length !== dimensions) throw new Error('Embedding dimensions changed while building the index.');
          const recordIndex = start + offset;
          const content = JSON.stringify({
            recordIndex,
            displayName: batch[offset].displayName,
            text: batch[offset].text,
            embeddingText: batch[offset].embeddingText,
          });
          await index.addVector(recordIndex, vector, content);
        }
      }

      const indexedAt = new Date().toISOString();
      await writeJsonFileAtomically(indexPath, {
        schemaVersion: MODEL_SEARCH_SCHEMA_VERSION,
        embeddingModel: embedder.model || MODEL_SEARCH_EMBEDDING_MODEL,
        dimensions,
        indexedAt,
        records,
        hnsw: index.serialize(),
      });
      loadedState = {
        index,
        records,
        documentFrequency: documentFrequencyFor(records),
        entityVocabulary: entityVocabularyFor(records),
        dimensions,
        embeddingModel: embedder.model || MODEL_SEARCH_EMBEDDING_MODEL,
        indexedAt,
      };
      return getStatus(loadedState);
    })();

    try {
      return await buildPromise;
    } finally {
      buildPromise = null;
    }
  };

  const getStatus = (state) => ({
    ready: Boolean(state),
    model: state?.embeddingModel || embedder.model || MODEL_SEARCH_EMBEDDING_MODEL,
    dimensions: state?.dimensions || null,
    recordCount: state?.records?.length || 0,
    indexedAt: state?.indexedAt || null,
    indexPath,
  });

  const status = async () => {
    if (loadedState) return getStatus(loadedState);
    try {
      const fileStat = await stat(indexPath);
      if (!fileStat.isFile()) return getStatus(null);
      return getStatus(await loadIndex());
    } catch (error) {
      if (error?.code === 'ENOENT') return getStatus(null);
      throw error;
    }
  };

  const search = async (query, {limit = DEFAULT_LIMIT} = {}) => {
    const normalizedQuery = cleanText(query);
    if (!normalizedQuery) throw new Error('A non-empty search query is required.');
    const state = await ensureLoaded();
    const [queryVector] = await embedBatch(embedder, [normalizedQuery]);
    if (queryVector.length !== state.dimensions) throw new Error('Query embedding dimensions do not match the index.');
    const queryTokens = tokensFor(normalizedQuery);

    // Ask TinkerBird for approximate neighbors, then re-rank the small local
    // catalog exactly. This keeps results stable even when a persisted HNSW
    // graph has a sparse entry point while still using TinkerBird as the index.
    const approximate = state.index.query(queryVector, Math.max(normalizeLimit(limit) * 4, 16));
    const approximateScores = new Map(approximate.map((entry) => [entry.id, entry.score]));
    const ranked = Array.from(state.index.nodes.values())
      .map((node) => ({
        record: state.records[node.id],
        semanticScore: cosineSimilarity(queryVector, Array.from(node.embedding)),
        approximateScore: approximateScores.get(node.id) || null,
      }))
      .filter((entry) => entry.record)
      .map((entry) => {
        const lexicalScore = lexicalOverlap(
          queryTokens,
          entry.record.embeddingText || entry.record.text,
          state.documentFrequency,
          state.records.length,
        );
        const descriptionScore = lexicalOverlap(
          queryTokens,
          entry.record.description,
          state.documentFrequency,
          state.records.length,
        );
        const intentScore = categoryIntentMatch(normalizedQuery, entry.record.category);
        const rareTermScore = rareTermOverlap(
          queryTokens,
          `${entry.record.displayName} ${entry.record.description}`,
          state.documentFrequency,
          state.records.length,
        );
        const entityScore = entityOverlap(
          queryTokens,
          entry.record.description,
          state.entityVocabulary,
        );
        return {
          ...entry,
          lexicalScore,
          descriptionScore,
          intentScore,
          rareTermScore,
          entityScore,
          score: entry.semanticScore * SEMANTIC_WEIGHT
            + lexicalScore * LEXICAL_WEIGHT
            + descriptionScore * DESCRIPTION_WEIGHT
            + intentScore * INTENT_WEIGHT
            + rareTermScore * RARE_TERM_WEIGHT
            + entityScore * ENTITY_WEIGHT,
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, normalizeLimit(limit))
      .map(({record, score, semanticScore, lexicalScore, descriptionScore, intentScore, rareTermScore, entityScore, approximateScore}) => ({
        ...record,
        score,
        semanticScore,
        lexicalScore,
        descriptionScore,
        intentScore,
        rareTermScore,
        entityScore,
        approximateScore,
      }));

    return {
      query: normalizedQuery,
      model: state.embeddingModel,
      results: ranked,
    };
  };

  return {
    buildIndex,
    search,
    status,
  };
};
