// Shared cue-sheet model for background-score generation. A cue sheet is the
// LLM's machine-readable direction for one continuous instrumental score:
// global style, contiguous timed sections, and hit points (reveals/climaxes)
// that the music should land on. Everything here is pure and runs in both the
// browser and the Node server.

export const MIN_SECTION_MS = 3000;
export const MAX_SECTION_MS = 120000;
export const MIN_SCORE_MS = 3000;
export const MAX_SCORE_MS = 600000;
export const SCORE_TRANSITIONS = ['cut', 'swell', 'drop', 'decay', 'sustain'];
export const HIT_POINT_KINDS = ['reveal', 'climax', 'turn', 'resolution'];

const asText = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const asTextList = (value) => (Array.isArray(value) ? value : [])
  .map((entry) => asText(entry)).filter(Boolean);

export const clampBpm = (value) => {
  const bpm = Math.round(Number(value));
  return Number.isFinite(bpm) ? Math.min(200, Math.max(50, bpm)) : 96;
};

// One 4/4 bar in milliseconds.
export const barDurationMs = (bpm) => 240000 / clampBpm(bpm);
export const beatDurationMs = (bpm) => 60000 / clampBpm(bpm);

const clampIntensity = (value) => {
  const intensity = Math.round(Number(value));
  return Number.isFinite(intensity) ? Math.min(10, Math.max(1, intensity)) : 5;
};

const normalizeTransition = (value) => {
  const transition = asText(value).toLowerCase();
  return SCORE_TRANSITIONS.includes(transition) ? transition : 'sustain';
};

const formatTime = (ms) => {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds < 10 ? '0' : ''}${Math.round(seconds * 10) / 10}`;
};

// Validates and repairs a raw LLM cue sheet into a guaranteed-playable one:
// sections become contiguous over [0, durationMs], every section runs
// MIN_SECTION_MS..MAX_SECTION_MS, and hit points stay inside the score.
export const normalizeCueSheet = (raw, {durationMs} = {}) => {
  const duration = Math.round(Number(durationMs));
  if (!Number.isFinite(duration) || duration < MIN_SCORE_MS) {
    throw new Error(`Score duration must be at least ${MIN_SCORE_MS / 1000} seconds.`);
  }
  if (duration > MAX_SCORE_MS) {
    throw new Error(`Score duration must be at most ${MAX_SCORE_MS / 1000} seconds.`);
  }
  const source = raw && typeof raw === 'object' ? raw : {};
  const globalSource = source.global && typeof source.global === 'object' ? source.global : {};
  const global = {
    genre: asText(globalSource.genre, 'cinematic instrumental underscore'),
    bpm: clampBpm(globalSource.bpm),
    key: asText(globalSource.key) || null,
    instrumentation: asTextList(globalSource.instrumentation),
    moodArc: asText(globalSource.moodArc) || null,
  };

  const candidates = (Array.isArray(source.sections) ? source.sections : [])
    .map((section) => section && typeof section === 'object' ? {
      name: asText(section.name),
      startMs: Math.round(Number(section.startMs)),
      intensity: clampIntensity(section.intensity),
      description: asText(section.description),
      transition: normalizeTransition(section.transition),
    } : null)
    .filter((section) => section && section.description
      && Number.isFinite(section.startMs) && section.startMs >= 0 && section.startMs < duration)
    .sort((left, right) => left.startMs - right.startMs);

  // Contiguity: the first section is pulled back to 0, and each section runs
  // until the next one starts (the last until the end of the score).
  let sections = candidates.map((section, index) => ({
    ...section,
    startMs: index === 0 ? 0 : section.startMs,
    endMs: index + 1 < candidates.length ? candidates[index + 1].startMs : duration,
  })).filter((section) => section.endMs > section.startMs);
  if (!sections.length) {
    sections = [{
      name: 'Full score', startMs: 0, endMs: duration, intensity: 5,
      description: global.moodArc || global.genre, transition: 'decay',
    }];
  }

  // Sections shorter than the model minimum are absorbed by their neighbor.
  const merged = [];
  for (const section of sections) {
    const previous = merged[merged.length - 1];
    if (previous && section.endMs - section.startMs < MIN_SECTION_MS) {
      previous.endMs = section.endMs;
      previous.transition = section.transition;
    } else if (previous && previous.endMs - previous.startMs < MIN_SECTION_MS) {
      section.startMs = previous.startMs;
      merged[merged.length - 1] = section;
    } else {
      merged.push({...section});
    }
  }

  // Sections longer than the model maximum are split into equal parts.
  const bounded = merged.flatMap((section) => {
    const length = section.endMs - section.startMs;
    if (length <= MAX_SECTION_MS) return [section];
    const parts = Math.ceil(length / MAX_SECTION_MS);
    const partLength = length / parts;
    return Array.from({length: parts}, (unused, index) => ({
      ...section,
      name: index === 0 ? section.name : `${section.name || 'Section'} (cont. ${index + 1})`,
      startMs: Math.round(section.startMs + index * partLength),
      endMs: index + 1 === parts ? section.endMs : Math.round(section.startMs + (index + 1) * partLength),
      transition: index + 1 === parts ? section.transition : 'sustain',
    }));
  });
  bounded.forEach((section, index) => {
    section.name = section.name || `Section ${index + 1}`;
  });

  const seen = new Set();
  const hitPoints = (Array.isArray(source.hitPoints) ? source.hitPoints : [])
    .map((hit) => hit && typeof hit === 'object' ? {
      timeMs: Math.round(Number(hit.timeMs)),
      kind: HIT_POINT_KINDS.includes(asText(hit.kind).toLowerCase()) ? asText(hit.kind).toLowerCase() : 'turn',
      treatment: asText(hit.treatment, 'clear musical accent'),
    } : null)
    .filter((hit) => hit && Number.isFinite(hit.timeMs) && hit.timeMs > 0 && hit.timeMs <= duration)
    .sort((left, right) => left.timeMs - right.timeMs)
    .filter((hit) => {
      const bucket = Math.round(hit.timeMs / 500);
      if (seen.has(bucket)) return false;
      seen.add(bucket);
      return true;
    });

  return {global, sections: bounded, hitPoints, durationMs: duration};
};

// Snaps interior section boundaries to the nearest 4/4 bar line of the cue
// sheet's BPM, so section changes (and the hits they carry) land musically.
// A snap is skipped when it would push a section under the model minimum.
export const quantizeSectionsToBars = (cueSheet) => {
  const bar = barDurationMs(cueSheet.global.bpm);
  const sections = cueSheet.sections.map((section) => ({...section}));
  for (let index = 1; index < sections.length; index += 1) {
    const snapped = Math.round(sections[index].startMs / bar) * bar;
    const boundary = Math.round(snapped);
    if (boundary <= 0 || boundary >= cueSheet.durationMs) continue;
    if (boundary - sections[index - 1].startMs < MIN_SECTION_MS) continue;
    if (sections[index].endMs - boundary < MIN_SECTION_MS) continue;
    sections[index - 1].endMs = boundary;
    sections[index].startMs = boundary;
  }
  return {...cueSheet, sections};
};

const intensityPhrase = (intensity) => {
  if (intensity <= 2) return 'barely-there, sparse and quiet';
  if (intensity <= 4) return 'understated, low intensity';
  if (intensity <= 6) return 'moderate intensity, steady momentum';
  if (intensity <= 8) return 'high intensity, driving and full';
  return 'maximum intensity, thunderous full ensemble';
};

const transitionPhrase = (transition) => ({
  cut: 'ends on a hard cut',
  swell: 'builds into a rising swell at the end',
  drop: 'lands on a hard drop at the end',
  decay: 'decays toward silence at the end',
  sustain: 'holds its level into the next section',
}[transition]);

// A hit exactly on a boundary belongs to the section it opens.
const hitPhrases = (cueSheet, section) => cueSheet.hitPoints
  .filter((hit) => hit.timeMs >= section.startMs
    && (hit.timeMs < section.endMs || section.endMs === cueSheet.durationMs))
  .map((hit) => `${hit.kind} accent ${Math.round((hit.timeMs - section.startMs) / 100) / 10}s in: ${hit.treatment}`);

const NEGATIVE_GLOBAL_STYLES = ['vocals', 'singing', 'lyrics', 'spoken word', 'rapping'];

// Maps a cue sheet onto the fal-ai/elevenlabs/music input contract: a
// composition plan with exact per-section durations, forced instrumental.
// The endpoint 422s when music_length_ms or force_instrumental accompany
// composition_plan: the summed section durations define the total length, and
// empty `lines` plus the negative vocal styles keep the piece instrumental.
export const buildElevenLabsMusicInput = (cueSheet) => ({
  composition_plan: {
    positive_global_styles: [
      cueSheet.global.genre,
      `${cueSheet.global.bpm} BPM`,
      ...(cueSheet.global.key ? [`in ${cueSheet.global.key}`] : []),
      ...cueSheet.global.instrumentation,
      ...(cueSheet.global.moodArc ? [cueSheet.global.moodArc] : []),
      'instrumental film underscore',
    ],
    negative_global_styles: [...NEGATIVE_GLOBAL_STYLES],
    sections: cueSheet.sections.map((section) => ({
      section_name: section.name.slice(0, 100),
      positive_local_styles: [
        section.description,
        intensityPhrase(section.intensity),
        transitionPhrase(section.transition),
        ...hitPhrases(cueSheet, section),
      ],
      negative_local_styles: [],
      duration_ms: section.endMs - section.startMs,
      lines: [],
    })),
  },
  respect_sections_durations: true,
  output_format: 'mp3_44100_128',
});

// Condenses a cue sheet into one prompt paragraph for single-prompt music
// models (Lyria 3, Stable Audio) and for the video-to-music style hint.
export const buildSingleMusicPrompt = (cueSheet) => [
  `Instrumental film underscore, ${cueSheet.global.genre}, ${cueSheet.global.bpm} BPM${cueSheet.global.key ? `, in ${cueSheet.global.key}` : ''}.`,
  cueSheet.global.instrumentation.length ? `Instrumentation: ${cueSheet.global.instrumentation.join(', ')}.` : '',
  cueSheet.global.moodArc ? `Mood arc: ${cueSheet.global.moodArc}.` : '',
  ...cueSheet.sections.map((section) =>
    `${formatTime(section.startMs)}–${formatTime(section.endMs)} ${section.name}: ${section.description}; ${intensityPhrase(section.intensity)}; ${transitionPhrase(section.transition)}.`),
  ...cueSheet.hitPoints.map((hit) =>
    `At ${formatTime(hit.timeMs)}, a ${hit.kind}: ${hit.treatment}.`),
  'No vocals, singing, or lyrics.',
].filter(Boolean).join(' ');

// Assembles the LLM context for score direction from a project snapshot.
// `clips` must already be in absolute "all"-view seconds (see visibleClips);
// `annotations` maps assetId -> Moondream frame description.
export const buildScoreContext = ({project, clips, theme = '', annotations = {}} = {}) => {
  if (!project) throw new Error('Score context requires a project.');
  const timelineClips = Array.isArray(clips) ? clips : [];
  const videoTrackIds = new Set((project.timeline?.tracks || [])
    .filter((track) => track.kind === 'video').map((track) => track.id));
  const assets = new Map((project.mediaAssets || []).map((asset) => [asset.id, asset]));
  const segments = timelineClips
    .filter((clip) => videoTrackIds.has(clip.trackId))
    .sort((left, right) => left.start - right.start)
    .map((clip) => {
      const asset = assets.get(clip.assetId);
      return {
        startMs: Math.round(clip.start * 1000),
        endMs: Math.round((clip.start + clip.duration) * 1000),
        sceneId: clip.sceneId || null,
        label: asText(asset?.name, 'Untitled clip'),
        prompt: asText(clip.provenance?.prompt)
          || asText(clip.provenance?.derivedMetadata?.prompt)
          || asText(asset?.metadata?.prompt),
        annotation: asText(annotations[clip.assetId]) || null,
      };
    })
    .filter((segment) => segment.endMs > segment.startMs);
  if (!segments.length) throw new Error('Add video clips to the timeline before generating a score.');

  const acts = ((project.storyboard?.nodes || []).filter((node) => node.kind === 'act'))
    .map((node, index, all) => ({
      actNumber: index + 1,
      actCount: all.length,
      sceneId: node.sceneId || null,
      title: asText(node.title, `Act ${index + 1}`),
      summary: asText(node.summary),
      beats: (node.beats || []).map((beat) => ({
        text: asText(beat.text),
        screenplay: asText(beat.screenplay?.text) || null,
      })).filter((beat) => beat.text),
    }));

  return {
    project: {id: project.project?.id || null, name: asText(project.project?.name, 'Untitled project')},
    theme: asText(theme) || asText(project.project?.metadata?.theme) || null,
    narrative: project.storyboard?.narrative || null,
    acts,
    segments,
    durationMs: Math.max(...segments.map((segment) => segment.endMs)),
  };
};
