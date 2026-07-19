const stringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry === 'string' && entry.trim())
  .map((entry) => entry.trim()))];

const imageAsset = (project, assetId) => (project?.mediaAssets || [])
  .find((asset) => asset.id === assetId && asset.kind === 'image') || null;

export const storyboardReferenceForClip = (project, clip) => {
  if (!project || !clip) return null;
  const params = clip.provenance?.params || {};
  const actId = typeof params.storyboardActId === 'string' ? params.storyboardActId : null;
  const beatId = typeof params.storyboardBeatId === 'string' ? params.storyboardBeatId : null;
  const acts = (project.storyboard?.nodes || []).filter((node) => node.kind === 'act');
  const requestedAct = actId ? acts.find((act) => act.id === actId) || null : null;
  const beatAct = beatId
    ? [requestedAct, ...acts.filter((act) => act !== requestedAct)]
      .filter(Boolean)
      .find((act) => act.beats?.some((beat) => beat.id === beatId)) || null
    : null;
  const beat = beatAct?.beats?.find((entry) => entry.id === beatId) || null;
  const beatAsset = beat?.hero?.assetId ? imageAsset(project, beat.hero.assetId) : null;
  if (beatAsset) {
    return {
      assetId: beatAsset.id,
      source: 'beat',
      actId: beatAct.id,
      beatId: beat.id,
      label: `${beatAct.title || `Act ${beatAct.actNumber || ''}`} · ${beat.text}`,
    };
  }

  const parentAssetIds = stringIds([
    ...(clip.provenance?.parentAssetIds || []),
    clip.provenance?.parentAssetId,
  ]);
  const parentAsset = parentAssetIds.map((assetId) => imageAsset(project, assetId)).find(Boolean) || null;
  return parentAsset ? {
    assetId: parentAsset.id,
    source: 'provenance',
    actId: beatAct?.id || actId,
    beatId,
    label: parentAsset.name || 'Original generation still',
  } : null;
};
