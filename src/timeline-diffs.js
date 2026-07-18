const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requireStore = (store) => {
  if (!store || typeof store.getProject !== 'function' || typeof store.dispatch !== 'function') {
    throw new TypeError('Timeline diffs require a project store.');
  }
  return store;
};

export const createTimelineDiffs = (projectStore) => {
  const store = requireStore(projectStore);

  const createProposal = (diff) => store.dispatch({type: 'timeline-diff/create', diff});

  const listPending = () => store.getProject().timelineDiffs.items
    .filter((diff) => diff.status === 'pending' || diff.status === 'stale')
    .map(clone);

  const accept = (diffId) => store.dispatch({type: 'timeline-diff/accept', diffId});
  const reject = (diffId) => store.dispatch({type: 'timeline-diff/reject', diffId});
  const markStale = (diffIds) => store.dispatch({type: 'timeline-diff/mark-stale', diffIds});

  return {createProposal, listPending, accept, reject, markStale};
};
