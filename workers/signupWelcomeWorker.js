const os = require('os');
const { Worker } = require('bullmq');
const User = require('../models/User');
const Client = require('../models/Client');
const LifecycleAutomationLog = require('../models/LifecycleAutomationLog');
const { sendPlatformWelcomeEmail } = require('../utils/core/emailService');
const {
  sendPlatformWelcomeWhatsApp,
  getPlatformWabaConfig,
} = require('../services/lifecycle/platformWelcomeWhatsApp');
const { getConnection } = require('../utils/messaging/queues/queueConnection');
const { QUEUE_NAME } = require('../utils/messaging/queues/signupWelcomeQueue');
const log = require('../utils/core/logger')('SignupWelcomeWorker');

const WORKER_ID = `${os.hostname()}:${process.pid}`;

async function writeLifecycleLog(entry) {
  try {
    await LifecycleAutomationLog.create(entry);
  } catch (err) {
    log.warn(`Lifecycle log write failed: ${err.message}`);
  }
}

async function processSignupWelcomeJob(job) {
  const userId = String(job?.data?.userId || '');
  if (!userId) return;

  const user = await User.findById(userId);
  if (!user) return;

  const client = await Client.findOne({ clientId: user.clientId }).lean();
  const emailSentForKey = `welcome-email:${user._id}`;
  const waSentForKey = `welcome-whatsapp:${user._id}`;

  const emailEnabled = String(process.env.SEND_SIGNUP_WELCOME_EMAIL || 'true').toLowerCase() !== 'false';
  if (!emailEnabled) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'email',
      status: 'skipped',
      reason: 'email_toggle_disabled',
      sentForKey: emailSentForKey,
      metadata: { workerId: WORKER_ID },
    });
  } else if (user.welcomeEmailSentAt) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'email',
      status: 'skipped',
      reason: 'already_sent',
      sentForKey: emailSentForKey,
      metadata: { workerId: WORKER_ID },
    });
  } else {
    try {
      user.welcomeEmailSentAt = new Date();
      await user.save();

      const ok = await sendPlatformWelcomeEmail({
        toEmail: user.email,
        merchantName: user.name || client?.name || client?.businessName || 'there',
        trialEndsAt: client?.trialEndsAt || null,
        plan: client?.plan || '',
      });

      if (!ok) {
        user.welcomeEmailSentAt = null;
        await user.save();
        await writeLifecycleLog({
          clientId: user.clientId,
          userId: user._id,
          clientName: client?.name || client?.businessName || '',
          automationType: 'welcome',
          channel: 'email',
          status: 'failed',
          reason: 'send_failed',
          sentForKey: emailSentForKey,
          metadata: { workerId: WORKER_ID },
        });
      } else {
        await writeLifecycleLog({
          clientId: user.clientId,
          userId: user._id,
          clientName: client?.name || client?.businessName || '',
          automationType: 'welcome',
          channel: 'email',
          status: 'sent',
          reason: '',
          sentForKey: emailSentForKey,
          metadata: { workerId: WORKER_ID },
        });
      }
    } catch (err) {
      log.warn(`Signup welcome email failed for ${userId}: ${err.message}`);
      user.welcomeEmailSentAt = null;
      await user.save().catch(() => {});
      await writeLifecycleLog({
        clientId: user.clientId,
        userId: user._id,
        clientName: client?.name || client?.businessName || '',
        automationType: 'welcome',
        channel: 'email',
        status: 'failed',
        reason: err.message || 'unknown_error',
        sentForKey: emailSentForKey,
        metadata: { workerId: WORKER_ID },
      });
    }
  }

  const waEnabled = String(process.env.SEND_SIGNUP_WELCOME_WHATSAPP || 'true').toLowerCase() !== 'false';
  if (!waEnabled) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'skipped',
      reason: 'whatsapp_toggle_disabled',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID },
    });
    return;
  }

  if (!user.phone) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'skipped',
      reason: 'no_phone',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID },
    });
    return;
  }

  if (user.welcomeWhatsappSentAt) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'skipped',
      reason: 'already_sent',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID },
    });
    return;
  }

  if (!getPlatformWabaConfig().configured) {
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'skipped',
      reason: 'platform_waba_not_configured',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID },
    });
    return;
  }

  try {
    user.welcomeWhatsappSentAt = new Date();
    await user.save();

    const waResult = await sendPlatformWelcomeWhatsApp({
      toPhone: user.phone,
      merchantName: user.name || client?.name || client?.businessName || 'there',
    });

    if (!waResult?.sent) {
      user.welcomeWhatsappSentAt = null;
      await user.save();
      await writeLifecycleLog({
        clientId: user.clientId,
        userId: user._id,
        clientName: client?.name || client?.businessName || '',
        automationType: 'welcome',
        channel: 'whatsapp',
        status: waResult?.skipped ? 'skipped' : 'failed',
        reason: waResult?.reason || 'send_failed',
        sentForKey: waSentForKey,
        metadata: { workerId: WORKER_ID },
      });
      return;
    }

    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'sent',
      reason: '',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID, templateName: waResult.templateName || '' },
    });
  } catch (err) {
    user.welcomeWhatsappSentAt = null;
    await user.save().catch(() => {});
    await writeLifecycleLog({
      clientId: user.clientId,
      userId: user._id,
      clientName: client?.name || client?.businessName || '',
      automationType: 'welcome',
      channel: 'whatsapp',
      status: 'failed',
      reason: err.message || 'unknown_error',
      sentForKey: waSentForKey,
      metadata: { workerId: WORKER_ID },
    });
  }
}

function startSignupWelcomeWorker() {
  const connection = getConnection();
  if (!connection) {
    log.warn('Redis unavailable — signup welcome worker disabled');
    return null;
  }
  const worker = new Worker(QUEUE_NAME, processSignupWelcomeJob, {
    connection,
    concurrency: Number(process.env.SIGNUP_WELCOME_WORKER_CONCURRENCY || 5),
  });
  worker.on('failed', (job, err) => log.warn(`Job ${job?.id} failed: ${err.message}`));
  log.info('Signup welcome worker started');
  return worker;
}

module.exports = { startSignupWelcomeWorker, processSignupWelcomeJob };
