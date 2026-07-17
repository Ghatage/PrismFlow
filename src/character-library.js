const requireText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export const createCharacterLibrary = ({getProject, dispatch}) => {
  if (typeof getProject !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('Character library requires a project store.');
  }

  const load = () => clone(getProject().characters || []);

  const createDraft = (name) => dispatch({
    type: 'character/create',
    name: requireText(name, 'Character name'),
  });

  const remove = (characterId) => dispatch({
    type: 'character/remove',
    characterId: requireText(characterId, 'Character id'),
  });

  const rename = (characterId, name) => dispatch({
    type: 'character/rename',
    characterId: requireText(characterId, 'Character id'),
    name: requireText(name, 'Character name'),
  });

  const setStatus = (characterId, status) => dispatch({
    type: 'character/status',
    characterId: requireText(characterId, 'Character id'),
    status: requireText(status, 'Character status'),
  });

  const recordVersion = (characterId, version) => dispatch({
    type: 'character/version-record',
    characterId: requireText(characterId, 'Character id'),
    version: clone(version || {}),
  });

  const activateVersion = (characterId, versionId) => dispatch({
    type: 'character/version-activate',
    characterId: requireText(characterId, 'Character id'),
    versionId: requireText(versionId, 'Version id'),
  });

  const lockVersion = (characterId, versionId) => dispatch({
    type: 'character/lock',
    characterId: requireText(characterId, 'Character id'),
    versionId: requireText(versionId, 'Version id'),
  });

  const unlockVersion = (characterId) => dispatch({
    type: 'character/unlock',
    characterId: requireText(characterId, 'Character id'),
  });

  return {load, createDraft, remove, rename, setStatus, recordVersion, activateVersion, lockVersion, unlockVersion};
};
