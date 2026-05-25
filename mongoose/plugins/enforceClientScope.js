'use strict';

const SCOPE_OPS = ['find', 'findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments'];

function enforceClientScope(schema, options = {}) {
  const field = options.field || 'clientId';
  const enabled =
    process.env.ENFORCE_CLIENT_SCOPE !== 'false' &&
    process.env.NODE_ENV !== 'test';

  for (const op of SCOPE_OPS) {
    schema.pre(op, function enforceScopePre() {
      if (!enabled) return;
      if (this.getOptions()?.bypassClientScope) return;
      const filter = this.getFilter?.() || this._conditions || {};
      if (filter[field] != null) return;
      // Primary-key lookups (e.g. findById) — route handlers must verify tenant on the loaded doc.
      if (filter._id != null) return;
      const err = new Error(`enforceClientScope: ${op} requires ${field} in filter`);
      err.code = 'CLIENT_SCOPE_REQUIRED';
      throw err;
    });
  }
}

module.exports = { enforceClientScope };
