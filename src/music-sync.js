// Beat detection and hit-point alignment for generated background scores.
// Everything operates on plain Float32Arrays and numbers so the same code is
// unit-testable in Node and usable on Web Audio AudioBuffers in the browser.

// Averages all channels of an AudioBuffer-shaped object into one Float32Array.
export const monoSamples = (audioBuffer) => {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return Float32Array.from(audioBuffer.getChannelData(0));
  const length = audioBuffer.length;
  const mixed = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) mixed[index] += data[index] / channels;
  }
  return mixed;
};

// Half-wave-rectified energy flux per hop: rises sharply on percussive onsets.
export const onsetEnvelope = (samples, sampleRate, {frameSize = 1024, hopSize = 512} = {}) => {
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const times = new Array(frameCount);
  const flux = new Array(frameCount);
  let previousEnergy = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * hopSize;
    let energy = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[offset + index];
      energy += sample * sample;
    }
    flux[frame] = Math.max(0, energy - previousEnergy);
    times[frame] = ((offset + frameSize / 2) / sampleRate) * 1000;
    previousEnergy = energy;
  }
  return {times, flux};
};

// Peak-picks the onset envelope with a moving mean + deviation threshold.
// Returns onset times in milliseconds, at least minGapMs apart.
export const detectBeats = (samples, sampleRate, {
  frameSize = 1024,
  hopSize = 512,
  minGapMs = 250,
  sensitivity = 1.5,
} = {}) => {
  const {times, flux} = onsetEnvelope(samples, sampleRate, {frameSize, hopSize});
  if (flux.length < 3) return [];
  const window = Math.max(4, Math.round(sampleRate / hopSize));
  const beats = [];
  let lastBeat = -Infinity;
  for (let frame = 1; frame < flux.length - 1; frame += 1) {
    if (flux[frame] < flux[frame - 1] || flux[frame] <= flux[frame + 1]) continue;
    const from = Math.max(0, frame - window);
    const to = Math.min(flux.length, frame + window + 1);
    let mean = 0;
    for (let index = from; index < to; index += 1) mean += flux[index];
    mean /= to - from;
    let deviation = 0;
    for (let index = from; index < to; index += 1) deviation += (flux[index] - mean) ** 2;
    deviation = Math.sqrt(deviation / (to - from));
    if (flux[frame] <= mean + sensitivity * deviation) continue;
    if (times[frame] - lastBeat < minGapMs) continue;
    lastBeat = times[frame];
    beats.push(Math.round(times[frame]));
  }
  return beats;
};

// Finds the single global delay (positive = start the music later) that makes
// detected beats land closest to the cue sheet's hit points. Returns the
// chosen offset plus the per-hit residual error at that offset.
export const bestAlignmentOffset = (hitPointsMs, beatTimesMs, {maxShiftMs = 350, stepMs = 5} = {}) => {
  const hits = (hitPointsMs || []).filter((time) => Number.isFinite(time));
  const beats = (beatTimesMs || []).filter((time) => Number.isFinite(time));
  if (!hits.length || !beats.length) return {offsetMs: 0, meanAbsErrorMs: null, alignments: []};
  const errorAt = (offset) => hits.map((hit) => {
    let best = Infinity;
    for (const beat of beats) {
      const delta = Math.abs(hit - (beat + offset));
      if (delta < best) best = delta;
    }
    return best;
  });
  let chosen = {offsetMs: 0, meanAbsErrorMs: Infinity};
  for (let offset = -maxShiftMs; offset <= maxShiftMs; offset += stepMs) {
    const errors = errorAt(offset);
    const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
    if (mean < chosen.meanAbsErrorMs - 1e-9
      || (Math.abs(mean - chosen.meanAbsErrorMs) < 1e-9 && Math.abs(offset) < Math.abs(chosen.offsetMs))) {
      chosen = {offsetMs: offset, meanAbsErrorMs: mean};
    }
  }
  const residuals = errorAt(chosen.offsetMs);
  return {
    offsetMs: chosen.offsetMs,
    meanAbsErrorMs: Math.round(chosen.meanAbsErrorMs * 10) / 10,
    alignments: hits.map((hit, index) => ({timeMs: hit, errorMs: Math.round(residuals[index])})),
  };
};

// Splits one continuous score file into per-scene clip placements for the
// scene-local timeline. `musicDelaySec` shifts the whole score against the
// video (positive = music starts later); the audio head is trimmed via
// sourceStart when the delay is negative.
export const scoreClipPlacements = ({scenes, audioDurationSec, musicDelaySec = 0} = {}) => {
  const placements = [];
  for (const scene of scenes || []) {
    const sceneStart = scene.offsetSec;
    const sceneEnd = scene.offsetSec + scene.lengthSec;
    if (!(scene.lengthSec > 0)) continue;
    const audioStartInView = Math.max(sceneStart, musicDelaySec);
    const sourceStart = audioStartInView - musicDelaySec;
    const remaining = audioDurationSec - sourceStart;
    const duration = Math.min(sceneEnd, audioStartInView + remaining) - audioStartInView;
    if (duration <= 0.05) continue;
    placements.push({
      sceneId: scene.sceneId,
      start: Math.round((audioStartInView - sceneStart) * 1000) / 1000,
      sourceStart: Math.round(sourceStart * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
    });
  }
  return placements;
};
