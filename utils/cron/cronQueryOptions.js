'use strict';

/** Mongoose query option for cross-tenant system crons (enforceClientScope bypass). */
const CRON_BYPASS_SCOPE = { bypassClientScope: true };

module.exports = { CRON_BYPASS_SCOPE };
