'use strict';

const { getAppRedis } = require('../utils/core/redisFactory');
const Notification = require('../models/Notification');

const KEY = 'cron:last_tick';
const ALERT_MS = 10 * 60 * 1000;

async function recordCronTick() {
  const redis = getAppRedis();
  if (redis) await redis.set(KEY, String(Date.now()), 'EX', 3600);
}

async function checkCronHealth() {
  const redis = getAppRedis();
  if (!redis) return;
  const last = await redis.get(KEY);
  if (!last) return;
  if (Date.now() - Number(last) > ALERT_MS) {
    const exists = await Notification.findOne({
      type: 'cron_health',
      createdAt: { $gte: new Date(Date.now() - ALERT_MS) },
    }).lean();
    if (exists) return;
    await Notification.create({
      clientId: 'system',
      type: 'cron_health',
      title: 'Cron worker may be down',
      message: 'No cron tick recorded in the last 10 minutes.',
      severity: 'critical',
    });
  }
}

module.exports = { recordCronTick, checkCronHealth };
