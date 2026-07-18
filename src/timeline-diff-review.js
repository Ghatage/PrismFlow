const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export const buildGhostItems = (diffs) => (Array.isArray(diffs) ? diffs : []).flatMap((diff) =>
  diff.operations.flatMap((operation, operationIndex) => {
    const common = {
      diffId: diff.id,
      operationIndex,
      type: operation.type,
      status: diff.status,
      summary: diff.summary,
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
