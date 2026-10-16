const phases = new Set(['idle', 'listening', 'thinking', 'speaking', 'error']);
const actions = {
  run: 'Running wall experiment', setWall: 'Updating wall', runTrial: 'Running trial', adjustRamp: 'Adjusting ramp',
  setRampCurve: 'Changing ramp', setRampHeight: 'Changing ramp', compare: 'Comparing paths',
  loadPhysicsResult: 'Loading result', loadTrajectory: 'Loading path',
  play: 'Playing', pause: 'Pausing', reset: 'Resetting playback', seek: 'Seeking',
  setView: 'Changing view', setVehicleScale: 'Resizing car', setEntrySpeed: 'Changing speed',
  setPlaybackRate: 'Changing playback speed', showModule: 'Showing module',
  hideModule: 'Hiding module', moveModule: 'Moving module',
};

const allowed = new Set(Object.keys(actions));

function text(value, name, required = false) {
  if (typeof value !== 'string' || value.length > 500 || (required && !value.trim())) {
    throw new TypeError(`${name} must be ${required ? 'nonempty ' : ''}text of at most 500 characters.`);
  }
  return value.trim();
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Voice input must be an object.');
}
function resultFeedback(command, result) {
  const attention = detail => ({phase: 'attention', detail});
  if (command === 'run' || command === 'runTrial' || command === 'adjustRamp') {
    if (!result?.before) throw new Error('Run cancelled. Check the settings and try again.');
    if ((command === 'adjustRamp' || (command === 'run' && result.search)) && !result.after) return attention('No clear ramp found. Try moving the wall.');
    const attempt = command === 'adjustRamp' || (command === 'run' && result.after) ? result.after : result.before;
    if (!attempt.result?.metrics?.traction_ok) return attention('Lost traction. Adjust the ramp.');
    if (attempt.assessment?.status === 'clear') return {phase: 'done', detail: result.after ? 'Ramp adjusted. Wall cleared.' : 'Run complete.'};
    if (attempt.assessment?.status === 'collision') return attention('Wall hit. Adjust the ramp.');
    return attention('Clearance could not be confirmed.');
  }
  if (result === false) throw new Error('The requested module is unavailable.');
  return {phase: 'done', detail: ({setWall: 'Wall updated.', setRampCurve: 'Ramp updated. Ready to run.',
    setRampHeight: 'Ramp updated. Ready to run.', compare: 'Before and after shown.',
    play: 'Playback started.', pause: 'Playback paused.', loadPhysicsResult: 'Result loaded.'})[command] || 'Applied.'};
}

/** Displays only host-supplied speech; recognition and intent selection stay with the engineer. */
export function createVoiceFeedback({ execute, render }) {
  let generation = 0;
  let state = {phase: 'idle', transcript: '', action: '', detail: ''};
  const getState = () => ({...state});
  const publish = () => { render(getState()); return getState(); };
  return Object.freeze({
    getState,
    setVoiceState(input) {
      object(input);
      if (!phases.has(input.phase)) throw new TypeError('Unknown voice phase.');
      const transcript = text(input.transcript ?? '', 'transcript');
      const detail = text(input.detail ?? '', 'detail');
      generation++;
      state = {phase: input.phase, transcript, detail, action: ''};
      return publish();
    },
    async runVoiceCommand(input) {
      object(input);
      const transcript = text(input.transcript, 'transcript', true);
      if (!allowed.has(input.command)) throw new TypeError('Unknown or disallowed voice command.');
      const id = ++generation;
      state = {phase: 'executing', transcript, action: actions[input.command], detail: ''};
      publish();
      try {
        const result = await execute(input.command, input.payload);
        const feedback = resultFeedback(input.command, result);
        if (id === generation) { state = {...state, ...feedback}; publish(); }
        return result;
      } catch (error) {
        if (id === generation) {
          state = {...state, phase: 'error', detail: String(error?.message || error).slice(0, 500)};
          publish();
        }
        throw error;
      }
    },
  });
}
