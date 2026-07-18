const findCharacterVersion = (project, versionId) => {
  for (const character of project.characters || []) {
    const version = character.versions.find((candidate) => candidate.id === versionId);
    if (version) return {character, version};
  }
  return null;
};

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
  return {
    prompt: clip.provenance?.prompt || '',
    referenceAssetIds: [...new Set(resolvedCharacterVersions.map((entry) => entry.sheetAssetId))],
    provenance: {
      ...(clip.provenance || {}),
      characterVersionIds,
      resolvedCharacterVersions,
    },
  };
};
