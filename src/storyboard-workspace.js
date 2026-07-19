import {
  applyStillContextSettings,
  buildStillContextItems,
  normalizeStillContextSettings,
} from './still-context.js';

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const DEFAULT_BEAT_X = 56;
const DEFAULT_BEAT_Y = 72;
const DEFAULT_BEAT_GAP = 380;

const normalizeBeat = (beat, index) => ({
  id: String(beat?.id || ''),
  text: String(beat?.text || ''),
  mentions: beat?.mentions && typeof beat.mentions === 'object' ? clone(beat.mentions) : {},
  layout: {
    x: Number.isFinite(beat?.layout?.x) ? beat.layout.x : DEFAULT_BEAT_X + index * DEFAULT_BEAT_GAP,
    y: Number.isFinite(beat?.layout?.y) ? beat.layout.y : DEFAULT_BEAT_Y,
  },
  hero: beat?.hero && typeof beat.hero === 'object' ? clone(beat.hero) : null,
  screenplay: beat?.screenplay && typeof beat.screenplay === 'object' ? clone(beat.screenplay) : null,
  videoPrompt: beat?.videoPrompt && typeof beat.videoPrompt === 'object' ? clone(beat.videoPrompt) : null,
  stillContext: normalizeStillContextSettings(beat?.stillContext),
});

const validConnections = (connections, beats) => {
  const beatIds = new Set(beats.map((beat) => beat.id));
  return connections
    .filter((connection) => connection && beatIds.has(connection.fromBeatId) && beatIds.has(connection.toBeatId))
    .map((connection) => ({
      id: String(connection.id),
      fromBeatId: String(connection.fromBeatId),
      toBeatId: String(connection.toBeatId),
    }));
};

export const createActWorkspace = ({project, actId, narrativeStyle = null, createId}) => {
  if (!project?.storyboard?.nodes || typeof createId !== 'function') {
    throw new TypeError('Act workspace requires a storyboard project and id generator.');
  }
  const source = project.storyboard.nodes.find((node) => node.kind === 'act' && node.id === actId);
  if (!source) throw new Error(`Storyboard act was not found: ${actId}`);

  const act = clone(source);
  act.beats = (act.beats || []).map(normalizeBeat);
  act.connections = Array.isArray(source.connections)
    ? validConnections(source.connections, act.beats)
    : act.beats.slice(1).map((beat, index) => ({
      id: createId('sb-link'),
      fromBeatId: act.beats[index].id,
      toBeatId: beat.id,
    }));
  let saved = JSON.stringify(act);

  const dispatch = (command = {}) => {
    if (command.type === 'act/update' && command.patch && typeof command.patch === 'object') {
      if (typeof command.patch.title === 'string' && command.patch.title.trim()) act.title = command.patch.title.trim();
      if (typeof command.patch.summary === 'string') act.summary = command.patch.summary;
    } else if (command.type === 'beat/update' && command.patch && typeof command.patch === 'object') {
      const beat = act.beats.find((entry) => entry.id === command.beatId);
      if (beat) {
        if (typeof command.patch.text === 'string' && command.patch.text.trim()) beat.text = command.patch.text.trim();
        if (command.patch.mentions && typeof command.patch.mentions === 'object') beat.mentions = clone(command.patch.mentions);
        if (command.patch.layout && Number.isFinite(command.patch.layout.x) && Number.isFinite(command.patch.layout.y)) {
          beat.layout = {x: command.patch.layout.x, y: command.patch.layout.y};
        }
        if (command.patch.hero === null || (command.patch.hero && typeof command.patch.hero === 'object')) {
          beat.hero = clone(command.patch.hero);
        }
        if (command.patch.screenplay === null || (command.patch.screenplay && typeof command.patch.screenplay === 'object')) {
          beat.screenplay = clone(command.patch.screenplay);
        }
        if (command.patch.videoPrompt === null || (command.patch.videoPrompt && typeof command.patch.videoPrompt === 'object')) {
          beat.videoPrompt = clone(command.patch.videoPrompt);
        }
        if (command.patch.stillContext && typeof command.patch.stillContext === 'object') {
          beat.stillContext = normalizeStillContextSettings(command.patch.stillContext);
        }
      }
    } else if (command.type === 'beat/insert') {
      const connectionIndex = act.connections.findIndex((connection) => connection.id === command.connectionId);
      const connection = act.connections[connectionIndex] || null;
      const beat = normalizeBeat({
        id: command.beat?.id || createId('sb-beat'),
        text: command.beat?.text || 'New beat',
        mentions: command.beat?.mentions || {},
        layout: command.beat?.layout,
      }, act.beats.length);
      if (connection) {
        const sourceBeat = act.beats.find((entry) => entry.id === connection.fromBeatId);
        const targetIndex = act.beats.findIndex((entry) => entry.id === connection.toBeatId);
        const targetBeat = act.beats[targetIndex];
        if (sourceBeat && targetBeat) {
          beat.layout = {
            x: sourceBeat.layout.x + DEFAULT_BEAT_GAP,
            y: sourceBeat.layout.y,
          };
          if (targetBeat.layout.x < beat.layout.x + DEFAULT_BEAT_GAP) {
            const shiftFrom = targetBeat.layout.x;
            act.beats.forEach((entry) => {
              if (entry.layout.x >= shiftFrom && Math.abs(entry.layout.y - targetBeat.layout.y) < 120) {
                entry.layout.x += DEFAULT_BEAT_GAP;
              }
            });
          }
          act.beats.splice(targetIndex, 0, beat);
          act.connections.splice(connectionIndex, 1,
            {id: createId('sb-link'), fromBeatId: sourceBeat.id, toBeatId: beat.id},
            {id: createId('sb-link'), fromBeatId: beat.id, toBeatId: targetBeat.id});
        }
      } else if (command.afterBeatId) {
        const sourceIndex = act.beats.findIndex((entry) => entry.id === command.afterBeatId);
        const sourceBeat = act.beats[sourceIndex];
        if (sourceBeat) {
          beat.layout = {x: sourceBeat.layout.x + DEFAULT_BEAT_GAP, y: sourceBeat.layout.y};
          act.beats.forEach((entry) => {
            if (entry.id !== sourceBeat.id && entry.layout.x >= beat.layout.x && Math.abs(entry.layout.y - beat.layout.y) < 120) {
              entry.layout.x += DEFAULT_BEAT_GAP;
            }
          });
          act.beats.splice(sourceIndex + 1, 0, beat);
          act.connections.push({id: createId('sb-link'), fromBeatId: sourceBeat.id, toBeatId: beat.id});
        }
      } else {
        act.beats.push(beat);
      }
    } else if (command.type === 'beat/remove') {
      act.beats = act.beats.filter((beat) => beat.id !== command.beatId);
      act.connections = act.connections.filter((connection) =>
        connection.fromBeatId !== command.beatId && connection.toBeatId !== command.beatId);
    }
    return read();
  };

  const read = () => ({
    act: clone(act),
    dirty: JSON.stringify(act) !== saved,
    completion: {
      beats: act.beats.length,
      stills: act.beats.filter((beat) => Boolean(beat.hero?.assetId)).length,
      screenplays: act.beats.filter((beat) => Boolean(beat.screenplay?.text?.trim())).length,
    },
  });

  const snapshot = () => clone(act);
  const markSaved = () => { saved = JSON.stringify(act); };

  const contextFor = (beatId) => {
    const targetIndex = act.beats.findIndex((beat) => beat.id === beatId);
    if (targetIndex < 0) throw new Error(`Storyboard beat was not found: ${beatId}`);
    const targetBeat = act.beats[targetIndex];
    const acts = project.storyboard.nodes
      .filter((node) => node.kind === 'act')
      .map((node) => node.id === act.id ? act : node)
      .toSorted((left, right) => (left.actNumber || 0) - (right.actNumber || 0));
    const currentIndex = acts.findIndex((entry) => entry.id === act.id);
    const storySoFar = acts.slice(0, currentIndex).map((entry) => ({
      id: entry.id,
      actNumber: entry.actNumber,
      title: entry.title,
      summary: entry.summary,
      beats: (entry.beats || []).map((beat) => ({
        id: beat.id,
        text: beat.text,
        screenplay: beat.screenplay?.text || '',
      })),
    }));
    if (targetIndex > 0) {
      storySoFar.push({
        id: act.id,
        actNumber: act.actNumber,
        title: act.title,
        summary: act.summary,
        beats: act.beats.slice(0, targetIndex).map((beat) => ({
          id: beat.id,
          text: beat.text,
          screenplay: beat.screenplay?.text || '',
        })),
      });
    }

    const mentionedIds = new Set(Object.values(targetBeat.mentions || {}).filter((id) => typeof id === 'string'));
    // Every character with a usable sheet anchors identity in every frame;
    // mentions only decide who is explicitly staged in this beat.
    const characters = (project.characters || []).map((character) => {
      const versionId = character.lockedVersionId || character.activeVersionId || character.versions?.at(-1)?.id || null;
      const version = character.versions?.find((candidate) => candidate.id === versionId) || null;
      return {
        id: character.id,
        name: character.name,
        versionId,
        sheetAssetId: version?.sheetAssetId || null,
        prompt: version?.prompt || '',
        mentioned: mentionedIds.has(character.id),
      };
    }).filter((character) => character.mentioned || character.sheetAssetId);

    const styleReferenceAssetIds = [...new Set((project.styles || [])
      .filter((style) => style.lockedVersionId)
      .flatMap((style) => style.versions?.find((candidate) => candidate.id === style.lockedVersionId)?.referenceAssetIds || []))]
      .slice(0, 4);

    const priorBeats = [
      ...acts.slice(0, currentIndex).flatMap((entry) => entry.beats || []),
      ...act.beats.slice(0, targetIndex),
    ];
    const previousBeat = priorBeats.findLast((beat) => beat.hero?.assetId) || null;

    return {
      project: {
        id: project.project?.id || null,
        name: project.project?.name || 'Untitled project',
        metadata: clone(project.project?.metadata || {}),
      },
      narrative: narrativeStyle ? {
        id: narrativeStyle.id,
        title: narrativeStyle.title,
        authors: [...(narrativeStyle.authors || [])],
        tagline: narrativeStyle.tagline || '',
        notes: [...(narrativeStyle.notes || [])],
      } : {
        id: project.storyboard.styleId || null,
        title: project.storyboard.styleTitle || '',
        authors: [],
        tagline: '',
        notes: [],
      },
      act: {
        id: act.id,
        sceneId: act.sceneId || null,
        actNumber: act.actNumber,
        title: act.title,
        summary: act.summary,
      },
      storySoFar,
      target: {
        id: targetBeat.id,
        text: targetBeat.text,
        screenplay: targetBeat.screenplay?.text || '',
      },
      characters,
      style: {
        bible: project.storyboard.visualStyle || '',
        referenceAssetIds: styleReferenceAssetIds,
      },
      previousStill: previousBeat ? {beatId: previousBeat.id, assetId: previousBeat.hero.assetId} : null,
    };
  };

  const stillContextFor = (beatId) => {
    const beat = act.beats.find((entry) => entry.id === beatId);
    if (!beat) throw new Error(`Storyboard beat was not found: ${beatId}`);
    return applyStillContextSettings(contextFor(beatId), beat.stillContext);
  };

  const stillContextItemsFor = (beatId) => {
    const beat = act.beats.find((entry) => entry.id === beatId);
    if (!beat) throw new Error(`Storyboard beat was not found: ${beatId}`);
    return buildStillContextItems(contextFor(beatId), beat.stillContext);
  };

  return {dispatch, read, snapshot, markSaved, contextFor, stillContextFor, stillContextItemsFor};
};
