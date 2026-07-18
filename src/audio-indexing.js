import {extractAudioFromBlob, resampleToMono} from './audio-extract.js';

export const AUDIO_TRANSCRIPTION_MODEL_ID = 'onnx-community/whisper-tiny.en';
export const AUDIO_TRANSCRIPTION_SAMPLE_RATE = 16000;

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const segmentIdFor = (audioAssetId, start) => `${audioAssetId}@${Number(start).toFixed(3)}`;

const responseJson = async (response, fallbackMessage) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || fallbackMessage);
  return payload;
};

let whisperPipelinePromise = null;

const defaultWhisperTranscribe = async (samples) => {
  whisperPipelinePromise ||= import('@huggingface/transformers')
    .then(({pipeline}) => pipeline('automatic-speech-recognition', AUDIO_TRANSCRIPTION_MODEL_ID));
  const transcriber = await whisperPipelinePromise;
  const output = await transcriber(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });
  const chunks = Array.isArray(output?.chunks) && output.chunks.length
    ? output.chunks
    : output?.text
      ? [{timestamp: [0, null], text: output.text}]
      : [];
  return chunks
    .map((chunk) => ({
      start: Number.isFinite(chunk.timestamp?.[0]) ? chunk.timestamp[0] : 0,
      end: Number.isFinite(chunk.timestamp?.[1]) ? chunk.timestamp[1] : null,
      text: clean(chunk.text),
    }))
    .filter((segment) => segment.text);
};

export const createAudioTranscriptionIndexer = ({
  getProject = () => null,
  fetchImpl = globalThis.fetch,
  transcribe = defaultWhisperTranscribe,
  decode = (blob) => extractAudioFromBlob(blob),
  resample = (audioBuffer) => resampleToMono(audioBuffer, {targetRate: AUDIO_TRANSCRIPTION_SAMPLE_RATE}),
  updateAsset = () => {},
  now = () => new Date().toISOString(),
  onProgress = () => {},
} = {}) => {
  if (typeof fetchImpl !== 'function') throw new TypeError('Audio indexing requires fetch.');
  const active = new Map();

  const indexRecords = async (records) => {
    if (!records.length) return;
    const response = await fetchImpl('/api/video/index', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({projectId: getProject()?.project?.id || null, records}),
    });
    await responseJson(response, 'Audio transcription could not be indexed.');
  };

  const run = async ({asset, blob, audioBuffer = null} = {}) => {
    if (!asset?.id || asset.kind !== 'audio') throw new Error('Only audio assets can be transcribed.');
    if (!blob && !audioBuffer) throw new Error('Audio transcription requires the audio blob.');
    if (active.has(asset.id)) return active.get(asset.id);
    const task = (async () => {
      updateAsset(asset.id, {audioIndex: {status: 'transcribing', modelId: AUDIO_TRANSCRIPTION_MODEL_ID, updatedAt: now()}});
      onProgress({audioAssetId: asset.id, status: 'transcribing'});
      const decoded = audioBuffer || (await decode(blob)).audioBuffer;
      const samples = await resample(decoded);
      const segments = await transcribe(samples);
      const createdAt = now();
      const transcription = {
        modelId: AUDIO_TRANSCRIPTION_MODEL_ID,
        segments,
        text: segments.map((segment) => segment.text).join(' '),
        createdAt,
      };
      const records = segments.map((segment) => ({
        id: segmentIdFor(asset.id, segment.start),
        projectId: getProject()?.project?.id || null,
        videoAssetId: asset.id,
        videoName: asset.name,
        time: segment.start,
        duration: asset.duration,
        annotation: segment.text,
        modelId: AUDIO_TRANSCRIPTION_MODEL_ID,
        searchText: `${asset.name}. ${segment.text}`,
        kind: 'audio-transcript',
        createdAt,
      }));
      await indexRecords(records);
      updateAsset(asset.id, {
        transcription,
        audioIndex: {status: 'complete', segmentCount: segments.length, modelId: AUDIO_TRANSCRIPTION_MODEL_ID, updatedAt: now()},
      });
      onProgress({audioAssetId: asset.id, status: 'complete', segmentCount: segments.length});
      return {transcription: clone(transcription), records: records.map(clone)};
    })();
    active.set(asset.id, task);
    try {
      return await task;
    } catch (error) {
      updateAsset(asset.id, {audioIndex: {status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: now()}});
      throw error;
    } finally {
      active.delete(asset.id);
    }
  };

  const resume = async ({assets = [], getBlob = () => null} = {}) => {
    const pending = (Array.isArray(assets) ? assets : []).filter((asset) =>
      asset?.kind === 'audio'
      && asset.metadata?.detachedFrom
      && asset.metadata?.audioIndex?.status
      && asset.metadata.audioIndex.status !== 'complete');
    return Promise.all(pending.map(async (asset) => {
      const blob = await getBlob(asset);
      if (!blob) return null;
      return run({asset, blob});
    }));
  };

  return {run, resume, segmentIdFor};
};
