'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const log = require('../utils/core/logger')('MediaRetention');
const { wrapCron } = require('../utils/core/perfLogger');

const RETENTION_MS = 24 * 60 * 60 * 1000;

const MEDIA_DIRS = [
  path.join(__dirname, '..', 'uploads', 'media'),
  path.join(__dirname, '..', 'uploads', 'outbound-media'),
];

function purgeOldFilesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return { deleted: 0, errors: 0 };
  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > RETENTION_MS) {
        fs.unlinkSync(full);
        deleted += 1;
      }
    } catch (err) {
      errors += 1;
      log.warn('media retention delete failed', { file: name, error: err.message });
    }
  }

  return { deleted, errors };
}

module.exports = function scheduleMediaRetention() {
  cron.schedule(
    '15 */6 * * *',
    wrapCron('MediaRetention', async () => {
      let totalDeleted = 0;
      for (const dir of MEDIA_DIRS) {
        const { deleted } = purgeOldFilesInDir(dir);
        totalDeleted += deleted;
      }
      if (totalDeleted > 0) {
        log.info(`Purged ${totalDeleted} media file(s) older than 24h`);
      }
    })
  );
};

module.exports.purgeOldFilesInDir = purgeOldFilesInDir;
