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
  const acceptAll = () => store.dispatch({type: 'timeline-diff/accept-all'});
  const rejectAll = () => store.dispatch({type: 'timeline-diff/reject-all'});
  const markStale = (diffIds) => store.dispatch({type: 'timeline-diff/mark-stale', diffIds});
  const rebase = (diffId) => store.dispatch({type: 'timeline-diff/rebase', diffId});

  return {createProposal, listPending, accept, reject, acceptAll, rejectAll, markStale, rebase};
};
