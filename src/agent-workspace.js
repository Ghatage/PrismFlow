const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

export const createAgentWorkspace = ({getProject, dispatch}) => {
  if (typeof getProject !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('Agent workspace requires a project store.');
  }

  const load = () => clone(getProject().agentWorkspace || {messages: [], script: {title: '', beats: []}});
  const addMessage = ({role = 'user', text, resultIds = [], frameIds = []} = {}) => dispatch({
    type: 'agent/message-add',
    message: {role, text: requiredText(text, 'Agent message'), resultIds, frameIds},
  });
  const updateScript = (patch) => dispatch({type: 'script/update', patch: clone(patch || {})});
  const addBeat = ({text, sceneId = null, clipIds = [], notes = '', status = 'draft'} = {}) => dispatch({
    type: 'script/beat-add',
    beat: {text: requiredText(text, 'Script beat'), sceneId, clipIds, notes, status},
  });
  const updateBeat = (beatId, patch) => dispatch({type: 'script/beat-update', beatId: requiredText(beatId, 'Script beat id'), patch: clone(patch || {})});
  const removeBeat = (beatId) => dispatch({type: 'script/beat-remove', beatId: requiredText(beatId, 'Script beat id')});

  return {load, addMessage, updateScript, addBeat, updateBeat, removeBeat};
};
