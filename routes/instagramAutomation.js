"use strict";

/**
 * Backwards-compat alias.
 *
 * Some scripts (e.g. module probes) and older server mounts referenced
 * `routes/instagramAutomation`. The canonical router lives in
 * `routes/igAutomationRoutes`.
 */

module.exports = require("./igAutomationRoutes");

