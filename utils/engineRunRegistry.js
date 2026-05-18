"use strict";

/**
 * Per-session abort flags so a DualBrain timeout stops further executeNode work
 * (Promise.race does not cancel the underlying async chain).
 */
const runs = new Map();

function runKey(clientId, phone) {
  return `${clientId}:${phone}`;
}

function beginEngineRun(clientId, phone) {
  const key = runKey(clientId, phone);
  const state = { aborted: false, startedAt: Date.now() };
  runs.set(key, state);
  return state;
}

function abortEngineRun(clientId, phone) {
  const key = runKey(clientId, phone);
  const state = runs.get(key);
  if (state) state.aborted = true;
}

function isEngineRunAborted(clientId, phone) {
  return runs.get(runKey(clientId, phone))?.aborted === true;
}

function endEngineRun(clientId, phone) {
  runs.delete(runKey(clientId, phone));
}

module.exports = {
  beginEngineRun,
  abortEngineRun,
  isEngineRunAborted,
  endEngineRun,
};
