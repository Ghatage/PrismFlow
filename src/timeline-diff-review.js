const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const REVIEWABLE_STATUSES = new Set(['pending', 'stale']);

const compareDiffs = (left, right) => {
  const createdAtOrder = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  return createdAtOrder || String(left.id || '').localeCompare(String(right.id || ''));
};

const reviewableDiffs = (diffs) => (Array.isArray(diffs) ? diffs : [])
  .filter((diff) => diff && REVIEWABLE_STATUSES.has(diff.status))
  .sort(compareDiffs);

export const listReviewableDiffs = (diffs) => reviewableDiffs(diffs).map(clone);

export const buildGhostItems = (diffs) => reviewableDiffs(diffs).flatMap((diff) =>
  (Array.isArray(diff.operations) ? diff.operations : []).flatMap((operation, operationIndex) => {
    const common = {
      diffId: diff.id,
      operationIndex,
      type: operation.type,
      status: diff.status,
      summary: diff.summary,
      source: diff.source,
      baseRevision: diff.baseRevision,
      provenance: clone(diff.provenance || {}),
      before: clone(operation.before),
      after: clone(operation.after),
    };
    if (operation.type === 'move') {
      return [
        {...common, key: `${diff.id}:${operationIndex}:destination`, role: 'destination', clip: clone(operation.after)},
        {...common, key: `${diff.id}:${operationIndex}:origin`, role: 'origin', clip: clone(operation.before)},
      ];
    }
    const role = operation.type === 'remove' ? 'removal' : 'proposal';
    return [{
      ...common,
      key: `${diff.id}:${operationIndex}:${role}`,
      role,
      clip: clone(operation.type === 'remove' ? operation.before : operation.after),
    }];
  }));

export const findGhostItem = (diffs, key) => buildGhostItems(diffs).find((item) => item.key === key) || null;

const primaryGhostForDiff = (diff) => buildGhostItems([diff]).find((item) => item.role !== 'origin')
  || buildGhostItems([diff])[0]
  || null;

/**
 * Review navigation is diff-oriented: a move has two visual ghosts, but one
 * review action. `ghostKey` points at the primary visual item for selection.
 */
export const listReviewItems = (diffs) => listReviewableDiffs(diffs)
  .map((diff) => {
    const ghost = primaryGhostForDiff(diff);
    return ghost ? {...ghost, reviewKey: diff.id, ghostKey: ghost.key} : null;
  })
  .filter(Boolean)
  .map(clone);

const selectReviewItem = (diffs, currentKey, direction) => {
  const items = listReviewItems(diffs);
  if (!items.length) return null;
  if (!currentKey) return items[0];
  const currentIndex = items.findIndex((item) => item.key === currentKey
    || item.ghostKey === currentKey
    || item.reviewKey === currentKey);
  if (currentIndex < 0) return items[0];
  const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + direction));
  return clone(items[nextIndex]);
};

export const selectFirstReviewItem = (diffs) => selectReviewItem(diffs, null, 0);
export const selectPreviousReviewItem = (diffs, currentKey) => selectReviewItem(diffs, currentKey, -1);
export const selectNextReviewItem = (diffs, currentKey) => selectReviewItem(diffs, currentKey, 1);

export const previewTimelineForDiff = (acceptedClips, diff) => {
  let clips = (Array.isArray(acceptedClips) ? acceptedClips : []).map(clone);
  if (!diff || !Array.isArray(diff.operations)) return clips;
  diff.operations.forEach((operation) => {
    if (operation.type === 'add') {
      clips.push(clone(operation.after));
      return;
    }
    const index = clips.findIndex((clip) => clip.id === operation.clipId);
    if (operation.type === 'remove') {
      if (index >= 0) clips.splice(index, 1);
    } else if (index >= 0) {
      clips[index] = clone(operation.after);
    }
  });
  return clips;
};

export const derivePreviewClips = previewTimelineForDiff;

export const enterPreview = (sessionState, diffId) => ({
  ...(isRecord(sessionState) ? clone(sessionState) : {}),
  previewDiffId: typeof diffId === 'string' ? diffId : null,
});

export const exitPreview = (sessionState) => ({
  ...(isRecord(sessionState) ? clone(sessionState) : {}),
  previewDiffId: null,
});

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const createReviewSession = ({acceptedClips = [], diffs = []} = {}) => {
  let accepted = clone(Array.isArray(acceptedClips) ? acceptedClips : []);
  let proposals = clone(Array.isArray(diffs) ? diffs : []);
  let sessionState = {selectedKey: null, previewDiffId: null};

  const currentDiff = () => listReviewableDiffs(proposals)
    .find((diff) => diff.id === sessionState.previewDiffId) || null;
  const updateSelection = (item) => {
    sessionState = {...sessionState, selectedKey: item?.key || null};
    return clone(item);
  };

  return {
    getState: () => clone(sessionState),
    listReviewableDiffs: () => listReviewableDiffs(proposals),
    listReviewItems: () => listReviewItems(proposals),
    buildGhostItems: () => buildGhostItems(proposals),
    selectFirst: () => updateSelection(selectFirstReviewItem(proposals)),
    selectPrevious: () => updateSelection(selectPreviousReviewItem(proposals, sessionState.selectedKey)),
    selectNext: () => updateSelection(selectNextReviewItem(proposals, sessionState.selectedKey)),
    enterPreview: (diffId) => {
      if (!listReviewableDiffs(proposals).some((diff) => diff.id === diffId)) return clone(sessionState);
      sessionState = enterPreview(sessionState, diffId);
      return clone(sessionState);
    },
    exitPreview: () => {
      sessionState = exitPreview(sessionState);
      return clone(sessionState);
    },
    getPlaybackClips: () => {
      const diff = currentDiff();
      return diff ? previewTimelineForDiff(accepted, diff) : clone(accepted);
    },
    update: ({acceptedClips: nextAcceptedClips, diffs: nextDiffs} = {}) => {
      if (nextAcceptedClips !== undefined) accepted = clone(Array.isArray(nextAcceptedClips) ? nextAcceptedClips : []);
      if (nextDiffs !== undefined) proposals = clone(Array.isArray(nextDiffs) ? nextDiffs : []);
      if (!currentDiff()) sessionState = {...sessionState, previewDiffId: null};
      if (!listReviewItems(proposals).some((item) => item.key === sessionState.selectedKey)) {
        sessionState = {...sessionState, selectedKey: null};
      }
      return clone(sessionState);
    },
  };
};

export const reviseGhostProposal = (diff, operationIndex, patch) => {
  if (!diff || !Array.isArray(diff.operations) || !diff.operations[operationIndex]) {
    throw new Error('The ghost operation is unavailable.');
  }
  const revised = clone(diff);
  const operation = revised.operations[operationIndex];
  if (operation.type === 'remove') throw new Error('Removal ghosts cannot be dragged.');
  const proposedClip = {...(operation.after || operation.proposedClip), ...patch};
  operation.after = proposedClip;
  if (operation.type === 'add' || operation.type === 'replace') operation.proposedClip = clone(proposedClip);
  delete revised.id;
  delete revised.status;
  delete revised.createdAt;
  delete revised.updatedAt;
  revised.summary = `${diff.summary} (revised)`;
  revised.provenance = {...diff.provenance, revisedFromDiffId: diff.id};
  return revised;
};
