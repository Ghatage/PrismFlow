const requireText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export const createStyleLibrary = ({getProject, dispatch}) => {
  if (typeof getProject !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('Style library requires a project store.');
  }

  const load = () => clone(getProject().styles || []);

  const createDraft = (name) => dispatch({
    type: 'style/create',
    name: requireText(name, 'Style name'),
  });

  const rename = (styleId, name) => dispatch({
    type: 'style/rename',
    styleId: requireText(styleId, 'Style id'),
    name: requireText(name, 'Style name'),
  });

  const setStatus = (styleId, status) => dispatch({
    type: 'style/status',
    styleId: requireText(styleId, 'Style id'),
    status: requireText(status, 'Style status'),
  });

  const recordVersion = (styleId, version) => dispatch({
    type: 'style/version-record',
    styleId: requireText(styleId, 'Style id'),
    version: clone(version || {}),
  });

  const activateVersion = (styleId, versionId) => dispatch({
    type: 'style/version-activate',
    styleId: requireText(styleId, 'Style id'),
    versionId: requireText(versionId, 'Version id'),
  });

  const lockVersion = (styleId, versionId) => dispatch({
    type: 'style/lock',
    styleId: requireText(styleId, 'Style id'),
    versionId: requireText(versionId, 'Version id'),
  });

  const unlockVersion = (styleId) => dispatch({
    type: 'style/unlock',
    styleId: requireText(styleId, 'Style id'),
  });

  const remove = (styleId) => dispatch({
    type: 'style/remove',
    styleId: requireText(styleId, 'Style id'),
  });

  const lockedVersions = () => load()
    .filter((style) => style.lockedVersionId)
    .map((style) => ({
      styleId: style.id,
      styleName: style.name,
      versionId: style.lockedVersionId,
      version: style.versions.find((candidate) => candidate.id === style.lockedVersionId) || null,
    }))
    .filter((entry) => entry.version);

  return {load, createDraft, rename, setStatus, recordVersion, activateVersion, lockVersion, unlockVersion, remove, lockedVersions};
};
