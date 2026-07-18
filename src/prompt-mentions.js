const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pickVersion = (character) => {
  const versions = character.versions || [];
  const byId = (versionId) => versions.find((version) => version.id === versionId) || null;
  return byId(character.lockedVersionId) || byId(character.activeVersionId) || versions[versions.length - 1] || null;
};

export const findMentions = (text, characters, mentionMap = {}) => {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const byId = new Map((characters || []).map((character) => [character.id, character]));
  const candidates = [];
  for (const [name, characterId] of Object.entries(mentionMap)) {
    if (byId.has(characterId)) candidates.push({name, characterId});
  }
  for (const character of characters || []) {
    if (character.name?.trim()) candidates.push({name: character.name, characterId: character.id});
  }
  candidates.sort((first, second) => second.name.length - first.name.length);

  const mentions = [];
  const claimed = [];
  const overlaps = (start, end) => claimed.some((range) => start < range.end && end > range.start);
  for (const candidate of candidates) {
    const pattern = new RegExp(`@${escapeRegExp(candidate.name)}(?![\\w])`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      claimed.push({start, end});
      mentions.push({characterId: candidate.characterId, name: candidate.name, start, end});
    }
  }
  return mentions.sort((first, second) => first.start - second.start);
};

export const resolveMentionedVersions = ({text, mentionMap = {}, project}) => {
  const characters = project?.characters || [];
  const mentions = findMentions(text, characters, mentionMap);
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const mention of mentions) {
    if (seen.has(mention.characterId)) continue;
    seen.add(mention.characterId);
    const character = characters.find((candidate) => candidate.id === mention.characterId);
    const version = character ? pickVersion(character) : null;
    if (!version) {
      unresolved.push({characterId: mention.characterId, name: mention.name});
      continue;
    }
    resolved.push({
      characterId: character.id,
      characterName: character.name,
      versionId: version.id,
      prompt: version.prompt || '',
      sheetAssetId: version.sheetAssetId || null,
    });
  }
  return {resolved, unresolved};
};

export const expandMentionPrompt = ({text, resolved}) => {
  const blocks = (resolved || [])
    .filter((entry) => entry.prompt.trim())
    .map((entry) => `Character reference — ${entry.characterName}: ${entry.prompt.trim()}`);
  if (!blocks.length) return text;
  return `${text.trimEnd()}\n\n${blocks.join('\n')}`;
};

export const imageInputFor = (modelId, modelInputs) => {
  const entry = modelInputs?.[modelId];
  if (!entry?.imageKey) return null;
  return {key: entry.imageKey, isArray: Boolean(entry.imageKeyIsArray)};
};
