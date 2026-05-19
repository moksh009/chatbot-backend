'use strict';

const path = require('path');

/** Backend repo root (chatbot-backend-main), regardless of script location. */
const BACKEND_ROOT = path.resolve(__dirname, '../..');

function loadSignoffEnv() {
  require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
}

function requireFromRoot(relativePath) {
  return require(path.join(BACKEND_ROOT, relativePath));
}

module.exports = { BACKEND_ROOT, loadSignoffEnv, requireFromRoot };
