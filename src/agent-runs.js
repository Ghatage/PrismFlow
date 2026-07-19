const RUN_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

export const createAgentRunStore = ({
  now = () => new Date().toISOString(),
  createId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
} = {}) => {
  const runs = [];
  const aborts = new Map();
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const get = (runId) => runs.find((run) => run.id === runId) || null;

  const requireRun = (runId) => {
    const run = get(runId);
    if (!run) throw new Error(`Unknown agent run: ${runId}`);
    return run;
  };

  return {
    create({prompt, clipContext = []}) {
      const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
      if (!trimmed) throw new Error('Agent prompt is required.');
      const run = {
        id: createId('agent-run'),
        prompt: trimmed,
        clipContext: Array.isArray(clipContext) ? structuredClone(clipContext) : [],
        status: 'running',
        createdAt: now(),
        updatedAt: now(),
        summary: null,
        error: null,
        steps: [],
      };
      runs.push(run);
      notify();
      return run;
    },

    get,
    list: () => runs.slice(),

    appendStep(runId, step) {
      const run = requireRun(runId);
      const record = {id: createId('agent-step'), at: now(), status: 'done', ...step};
      run.steps.push(record);
      run.updatedAt = now();
      notify();
      return record;
    },

    updateStep(runId, stepId, patch) {
      const run = requireRun(runId);
      const step = run.steps.find((item) => item.id === stepId);
      if (!step) throw new Error(`Unknown agent step: ${stepId}`);
      Object.assign(step, patch);
      run.updatedAt = now();
      notify();
      return step;
    },

    setStatus(runId, status, {summary = null, error = null} = {}) {
      if (!RUN_STATUSES.has(status)) throw new Error(`Invalid agent run status: ${status}`);
      const run = requireRun(runId);
      run.status = status;
      if (summary !== null) run.summary = summary;
      if (error !== null) run.error = error;
      run.updatedAt = now();
      if (status !== 'running') aborts.delete(runId);
      notify();
      return run;
    },

    registerAbort(runId, controller) {
      requireRun(runId);
      aborts.set(runId, controller);
    },

    cancel(runId) {
      const run = requireRun(runId);
      if (run.status !== 'running') return run;
      const controller = aborts.get(runId);
      if (controller) controller.abort();
      return run;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
