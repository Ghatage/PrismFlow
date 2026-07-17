const findCharacterVersion = (project, versionId) => {
  for (const character of project.characters || []) {
    const version = character.versions.find((candidate) => candidate.id === versionId);
    if (version) return {character, version};
  }
  return null;
};

const findStyleVersion = (project, versionId) => {
  for (const style of project.styles || []) {
    const version = (style.versions || []).find((candidate) => candidate.id === versionId);
    if (version) return {style, version};
  }
  return null;
};

export const lockedStyleVersionIds = (project) => (project.styles || [])
  .map((style) => style.lockedVersionId)
  .filter((versionId) => typeof versionId === 'string' && versionId.trim());

export const buildGenerationRequest = ({clip, project}) => {
  if (!clip || !project) throw new TypeError('Generation requests require a clip and project.');
  const characterVersionIds = [...new Set(Array.isArray(clip.provenance?.characterVersionIds) ? clip.provenance.characterVersionIds : [])];
  const resolvedCharacterVersions = characterVersionIds.map((versionId) => {
    const found = findCharacterVersion(project, versionId);
    if (!found) throw new Error(`Character version is missing: ${versionId}`);
    if (!found.version.sheetAssetId) throw new Error(`Character version has no sheet asset: ${versionId}`);
    return {
      characterId: found.character.id,
      characterName: found.character.name,
      versionId,
      sheetAssetId: found.version.sheetAssetId,
    };
  });
  const styleVersionIds = [...new Set([
    ...(Array.isArray(clip.provenance?.styleVersionIds) ? clip.provenance.styleVersionIds : []),
    ...lockedStyleVersionIds(project),
  ])];
  const resolvedStyleVersions = styleVersionIds.map((versionId) => {
    const found = findStyleVersion(project, versionId);
    if (!found) throw new Error(`Style version is missing: ${versionId}`);
    if (!found.version.referenceAssetIds.length) throw new Error(`Style version has no reference assets: ${versionId}`);
    return {
      styleId: found.style.id,
      styleName: found.style.name,
      versionId,
      referenceAssetIds: [...found.version.referenceAssetIds],
    };
  });
  return {
    prompt: clip.provenance?.prompt || '',
    referenceAssetIds: [...new Set([
      ...resolvedCharacterVersions.map((entry) => entry.sheetAssetId),
      ...resolvedStyleVersions.flatMap((entry) => entry.referenceAssetIds),
    ])],
    provenance: {
      ...(clip.provenance || {}),
      characterVersionIds,
      styleVersionIds,
      resolvedCharacterVersions,
      resolvedStyleVersions,
    },
  };
};
