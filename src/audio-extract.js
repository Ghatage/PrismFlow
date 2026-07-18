export class AudioExtractError extends Error {
  constructor(message, code = 'decode-failed') {
    super(message);
    this.name = 'AudioExtractError';
    this.code = code;
  }
}

const writeString = (view, offset, text) => {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
};

export const audioBufferToWavBlob = (buffer) => {
  const channelCount = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frameCount = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let channel = 0; channel < channelCount; channel += 1) channels.push(buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([arrayBuffer], {type: 'audio/wav'});
};

export const extractAudioFromBlob = async (blob, {audioContextClass = globalThis.AudioContext} = {}) => {
  if (!blob) throw new AudioExtractError('Audio extraction requires a media blob.', 'missing-source');
  if (typeof audioContextClass !== 'function') throw new AudioExtractError('Audio extraction requires Web Audio support.', 'unsupported');
  const context = new audioContextClass();
  try {
    const bytes = await blob.arrayBuffer();
    let audioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(bytes);
    } catch {
      throw new AudioExtractError('This media has no decodable audio track.', 'no-audio');
    }
    if (!audioBuffer || audioBuffer.numberOfChannels === 0 || audioBuffer.length === 0) {
      throw new AudioExtractError('This media has no audio track.', 'no-audio');
    }
    return {
      wavBlob: audioBufferToWavBlob(audioBuffer),
      audioBuffer,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
    };
  } finally {
    await context.close?.().catch?.(() => {});
  }
};

export const resampleToMono = async (audioBuffer, {
  targetRate = 16000,
  offlineAudioContextClass = globalThis.OfflineAudioContext,
} = {}) => {
  if (!audioBuffer?.length) throw new AudioExtractError('Resampling requires a decoded audio buffer.', 'missing-source');
  if (audioBuffer.numberOfChannels === 1 && audioBuffer.sampleRate === targetRate) {
    return audioBuffer.getChannelData(0);
  }
  if (typeof offlineAudioContextClass !== 'function') throw new AudioExtractError('Resampling requires OfflineAudioContext support.', 'unsupported');
  const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
  const context = new offlineAudioContextClass(1, frameCount, targetRate);
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
};
