'use strict';

/** Canonical socket emit only (Phase 5 — dual-emit removed). */
function emitDual(io, room, canonicalEvent, payload) {
  if (!io || !room) return;
  io.to(room).emit(canonicalEvent, payload);
}

module.exports = { emitDual };
