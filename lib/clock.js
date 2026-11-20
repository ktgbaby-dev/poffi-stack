// One clock for the whole app so tests can move time deliberately.
let offsetMs = 0;
let fixedMs = null;

export const now = () => (fixedMs ?? Date.now()) + offsetMs;
export const nowDate = () => new Date(now());

// Test helpers.
export function setNow(ms) { fixedMs = ms; offsetMs = 0; }
export function advance(ms) { if (fixedMs !== null) fixedMs += ms; else offsetMs += ms; }
export function resetClock() { fixedMs = null; offsetMs = 0; }
