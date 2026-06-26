"use strict";

const mongoose = require("mongoose");
const {
  sanitizePhoneForStorage,
  sanitizePhoneFieldsInUpdate,
  isPhoneSchemaPath,
} = require("../utils/core/phoneE164Policy");

let registered = false;

function getPhonePaths(schema) {
  return Object.keys(schema.paths).filter(isPhoneSchemaPath);
}

/**
 * Mongoose plugin: coerce phone fields to E.164 (+CC…) on save and update.
 */
function phoneE164Plugin(schema) {
  const phonePaths = getPhonePaths(schema);
  if (!phonePaths.length) return;

  const sanitizeDoc = (doc) => {
    if (!doc) return;
    for (const path of phonePaths) {
      const val = doc.get ? doc.get(path) : doc[path];
      if (val == null || val === "") continue;
      const normalized = sanitizePhoneForStorage(val);
      if (normalized) {
        if (doc.set) doc.set(path, normalized);
        else doc[path] = normalized;
      }
    }
  };

  schema.pre("save", function phoneE164PreSave() {
    sanitizeDoc(this);
  });

  const preUpdateHook = function phoneE164PreUpdate() {
    const update = this.getUpdate() || {};
    const sanitized = sanitizePhoneFieldsInUpdate(update, phonePaths);
    if (sanitized !== update) this.setUpdate(sanitized);
  };

  schema.pre("findOneAndUpdate", preUpdateHook);
  schema.pre("updateOne", preUpdateHook);
  schema.pre("updateMany", preUpdateHook);

  schema.pre("insertMany", function phoneE164PreInsertMany(next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    for (const doc of list) {
      if (doc && typeof doc === "object") sanitizeDoc(doc);
    }
    next();
  });

  for (const path of phonePaths) {
    if (schema.path(path)) {
      schema.path(path).set((val) => {
        if (val == null || val === "") return val;
        return sanitizePhoneForStorage(val) || val;
      });
    }
  }
}

function registerPhoneE164GlobalPlugin() {
  if (registered) return;
  mongoose.plugin(phoneE164Plugin);
  registered = true;
}

module.exports = {
  phoneE164Plugin,
  registerPhoneE164GlobalPlugin,
  getPhonePaths,
};
