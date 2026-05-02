/**
 * Import Batch ID Resolver
 * --------------------------------------------------------------------------
 * The product exposes two distinct identifiers for a single import batch:
 *
 *   1. ImportSession._id          → real Mongo ObjectId (24-char hex)
 *   2. ImportSession.batchId      → human/generated string of the form
 *                                   `BATCH_<unix-ms>_<random>`
 *
 * However, AdLead.importBatchId is schema-typed as ObjectId. So whenever the
 * frontend (or a stored Campaign) hands us the `BATCH_*` string, Mongoose
 * will throw `CastError: Cast to ObjectId failed for value "BATCH_…"`.
 *
 * This helper normalizes ANY caller-provided form into the underlying
 * ImportSession._id ObjectId so downstream queries on AdLead.importBatchId
 * are always safe.
 *
 * IMPORTANT: When clientId is provided, the lookup is scoped by clientId so a
 * tenant cannot accidentally (or maliciously) target an import batch that
 * belongs to another tenant.
 */

const mongoose = require('mongoose');
const ImportSession = require('../models/ImportSession');

const HEX24 = /^[a-fA-F0-9]{24}$/;

/**
 * @param {string|mongoose.Types.ObjectId|null|undefined} value
 * @param {string|null} [clientId] - Tenant scope. Strongly recommended.
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
async function resolveImportBatchObjectId(value, clientId = null) {
  if (!value) return null;

  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  const str = String(value).trim();
  if (!str) return null;

  // Already looks like a Mongo ObjectId — verify ownership when we can.
  if (HEX24.test(str)) {
    if (!clientId) return new mongoose.Types.ObjectId(str);
    const session = await ImportSession.findOne({ _id: str, clientId })
      .select('_id')
      .lean();
    return session ? session._id : null;
  }

  // Otherwise treat as the human/generated batchId (e.g. BATCH_xxx)
  const filter = clientId ? { batchId: str, clientId } : { batchId: str };
  const session = await ImportSession.findOne(filter).select('_id').lean();
  return session ? session._id : null;
}

module.exports = { resolveImportBatchObjectId };
