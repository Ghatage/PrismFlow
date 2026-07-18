const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const findVersion = (project, versionId) => {
  for (const character of project.characters || []) {
    const versionIndex = character.versions.findIndex((version) => version.id === versionId);
    if (versionIndex >= 0) return {character, version: character.versions[versionIndex], versionIndex};
  }
  return null;
};

export const createTimelineCharacterAttachments = ({getProject, dispatch}) => {
  if (typeof getProject !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('Timeline character attachments require a project store.');
  }

  const lockedVersions = (clipId) => {
    const project = getProject();
    const clip = project.timeline.clips.find((candidate) => candidate.id === clipId);
    const attached = new Set(clip?.provenance.characterVersionIds || []);
    return project.characters
      .filter((character) => character.lockedVersionId && !attached.has(character.lockedVersionId))
      .map((character) => {
        const versionIndex = character.versions.findIndex((version) => version.id === character.lockedVersionId);
        return {
          characterId: character.id,
          characterName: character.name,
          versionId: character.lockedVersionId,
          versionNumber: versionIndex + 1,
          sheetAssetId: character.versions[versionIndex]?.sheetAssetId || null,
        };
      });
  };

  const attachedVersions = (clipId) => {
    const project = getProject();
    const clip = project.timeline.clips.find((candidate) => candidate.id === clipId);
    return (clip?.provenance.characterVersionIds || []).map((versionId) => {
      const found = findVersion(project, versionId);
      if (!found) return {versionId, missing: true};
      return {
        characterId: found.character.id,
        characterName: found.character.name,
        versionId,
        versionNumber: found.versionIndex + 1,
        sheetAssetId: found.version.sheetAssetId,
        isLocked: found.character.lockedVersionId === versionId,
        missing: false,
      };
    });
  };

  const attach = (clipId, versionId) => dispatch({
    type: 'clip/character-attach',
    clipId: requiredText(clipId, 'Clip id'),
    versionId: requiredText(versionId, 'Character version id'),
  });

  const remove = (clipId, versionId) => dispatch({
    type: 'clip/character-remove',
    clipId: requiredText(clipId, 'Clip id'),
    versionId: requiredText(versionId, 'Character version id'),
  });

  return {
    lockedVersions: (clipId) => clone(lockedVersions(clipId)),
    attachedVersions: (clipId) => clone(attachedVersions(clipId)),
    attach,
    remove,
  };
};
