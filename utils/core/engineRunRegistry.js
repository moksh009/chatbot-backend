"use strict";

const crypto = require("crypto");

/**
 * Per-session run registry so DualBrain timeouts stop stale executeNode chains.
 * Finished/aborted runIds stay blocked briefly so setTimeout auto-forwards cannot run late.
 */
const runs = new Map();
/** @type {Map<string, Set<string>>} */
const finishedRunIds = new Map();

const FINISHED_TTL_MS = Number(process.env.ENGINE_ABORT_TTL_MS || 45000);

function runKey(clientId, phone) {
  return `${clientId}:${phone}`;
}

function markRunFinished(clientId, phone, runId) {
  if (!runId) return;
  const key = runKey(clientId, phone);
  if (!finishedRunIds.has(key)) finishedRunIds.set(key, new Set());
  finishedRunIds.get(key).add(runId);
  setTimeout(() => {
    finishedRunIds.get(key)?.delete(runId);
    if (finishedRunIds.get(key)?.size === 0) finishedRunIds.delete(key);
  }, FINISHED_TTL_MS).unref?.();
}

function beginEngineRun(clientId, phone) {
  const key = runKey(clientId, phone);
  const runId = crypto.randomUUID();
  runs.set(key, {
    runId,
    outboundSent: false,
    startedAt: Date.now(),
  });
  return runId;
}

function getEngineRunId(clientId, phone) {
  return runs.get(runKey(clientId, phone))?.runId || null;
}

function markOutboundSent(clientId, phone) {
  const state = runs.get(runKey(clientId, phone));
  if (state) state.outboundSent = true;
}

function wasOutboundSent(clientId, phone) {
  return runs.get(runKey(clientId, phone))?.outboundSent === true;
}

function abortEngineRun(clientId, phone) {
  const runId = getEngineRunId(clientId, phone);
  markRunFinished(clientId, phone, runId);
}

function isEngineRunAborted(clientId, phone, runId) {
  if (!runId) return false;
  return finishedRunIds.get(runKey(clientId, phone))?.has(runId) === true;
}

function endEngineRun(clientId, phone) {
  const key = runKey(clientId, phone);
  const runId = runs.get(key)?.runId;
  runs.delete(key);
  markRunFinished(clientId, phone, runId);
}

module.exports = {
  beginEngineRun,
  getEngineRunId,
  abortEngineRun,
  isEngineRunAborted,
  markOutboundSent,
  wasOutboundSent,
  endEngineRun,
};
