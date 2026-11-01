export class TrackerAgentBindingError extends Error {
  constructor(message = 'Tracker connection or scope changed. Create a new run from the current automation.') { super(message); }
}
