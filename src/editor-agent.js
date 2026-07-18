const SYSTEM_PROMPT = [
  'You are PrismFlow\'s timeline editing agent. You edit a video timeline on behalf of the user,',
  'exactly like a human editor would. Every tool call applies immediately and the user watches the',
  'timeline change live, so prefer small, verifiable edits and re-read clip state after mutating.',
  'Always call get_project_overview and list_timeline_clips before your first edit.',
  'All times are in seconds on the timeline unless a tool says otherwise.',
  'Clip "transcriptions" are visual frame annotations captured every 5 seconds of source footage.',
  'If a tool returns ok:false or an error, read the reason, re-check state, and adjust.',
  'When the task is complete, reply with a short plain-text summary of the edits you made,',
  'without calling any more tools.',
].join(' ');

export class AgentCancelledError extends Error {
  constructor() {
    super('Agent run was cancelled.');
    this.name = 'AgentCancelledError';
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new AgentCancelledError();
};

export const runEditorAgent = async ({
  prompt,
  tools,
  callLlm,
  onStep = () => {},
  maxIterations = 24,
  signal,
}) => {
  const messages = [
    {role: 'system', content: SYSTEM_PROMPT},
    {role: 'user', content: prompt},
  ];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    throwIfAborted(signal);

    let response;
    try {
      response = await callLlm({messages, tools: tools.definitions, signal});
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw new AgentCancelledError();
      throw error;
    }
    const message = response?.choices?.[0]?.message;
    if (!message) throw new Error('LLM response had no message.');
    messages.push(message);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (typeof message.content === 'string' && message.content.trim()) {
      onStep({
        type: toolCalls.length ? 'thought' : 'result',
        text: message.content.trim(),
        status: 'done',
      });
    }

    if (!toolCalls.length) {
      return {summary: typeof message.content === 'string' ? message.content.trim() : '', iterations: iteration + 1};
    }

    for (const call of toolCalls) {
      throwIfAborted(signal);
      const name = call.function?.name || 'unknown';
      let args = null;
      let result;
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        result = {error: 'Tool arguments were not valid JSON.'};
      }
      const step = onStep({type: 'tool', name, args, status: 'running'});
      if (!result) result = await tools.execute(name, args);
      const failed = Boolean(result && typeof result === 'object' && result.error);
      onStep({type: 'tool', name, args, result, status: failed ? 'error' : 'done'}, step);
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? null)});
    }
  }

  return {summary: `Stopped after reaching the ${maxIterations}-step limit.`, iterations: maxIterations, capped: true};
};
