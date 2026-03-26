const cron = require('node-cron');
const { DateTime } = require('luxon');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const BirthdayUser = require('../models/BirthdayUser');
const DailyStat = require('../models/DailyStat');
const { sendBirthdayWishWithImage } = require('../utils/sendBirthdayMessage');

const scheduleBirthdayCron = () => {
  // Run daily at 6:00 AM IST
  cron.schedule('0 6 * * *', async () => {
    const istNow = DateTime.utc().setZone('Asia/Kolkata');
    const currentDay = istNow.day;
    const currentMonth = istNow.month;
    const todayStr = istNow.toISODate();

    console.log(`⏰ It's 6:00 AM IST — Running Phase 9 Birthday check...`);

    try {
      const clients = await Client.find({});

      for (const client of clients) {
        const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
        const phoneid = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
        const clientId = client.clientId;

        if (!token || !phoneid) continue;

        let successCount = 0;
        let failureCount = 0;

        // 1. LEGACY BirthdayUser check
        let legacyQuery = { day: currentDay, month: currentMonth, isOpted: true };
        if (clientId === 'code_clinic_v1') {
          legacyQuery.$or = [{ clientId: clientId }, { clientId: { $exists: false } }];
        } else {
          legacyQuery.clientId = clientId;
        }

        const legacyBirthdays = await BirthdayUser.find(legacyQuery);
        for (const user of legacyBirthdays) {
          try {
            const result = await sendBirthdayWishWithImage(user.number, token, phoneid, clientId);
            if (result.success) successCount++;
            else failureCount++;
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            failureCount++;
          }
        }

        // 2. PHASE 9 AdLead CRM Birthday check
        // Check leads where birthday is today and message not sent yet
        const startOfDay = istNow.startOf('day').toJSDate();
        const endOfDay = istNow.endOf('day').toJSDate();

        const newBirthdays = await AdLead.find({
            clientId: clientId,
            birthday: { $ne: null },
            $expr: {
                $and: [
                    { $eq: [{ $dayOfMonth: "$birthday" }, currentDay] },
                    { $eq: [{ $month: "$birthday" }, currentMonth] }
                ]
            },
            // Don't send double if already sent this year
            $or: [
                { birthdayMsgSent: { $lt: startOfDay } },
                { birthdayMsgSent: { $exists: false } }
            ]
        });

        for (const lead of newBirthdays) {
            // Deduplicate if already processed via legacy
            if (legacyBirthdays.some(b => b.number === lead.phoneNumber)) {
                await AdLead.findByIdAndUpdate(lead._id, { birthdayMsgSent: new Date() });
                continue;
            }

            try {
                // Send birthday message
                const result = await sendBirthdayWishWithImage(lead.phoneNumber, token, phoneid, clientId);
                if (result.success) {
                    successCount++;
                    await AdLead.findByIdAndUpdate(lead._id, { birthdayMsgSent: new Date() });
                } else {
                    failureCount++;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                failureCount++;
            }
        }

        // 3. Update Daily Stats if any were sent
        if (successCount > 0) {
            await DailyStat.updateOne(
                { clientId: clientId, date: todayStr },
                { $inc: { birthdayRemindersSent: successCount }, $setOnInsert: { clientId: clientId, date: todayStr } },
                { upsert: true }
            );
        }

        if (successCount > 0 || failureCount > 0) {
            console.log(`🎂 Birthdays for ${clientId}: ${successCount} sent, ${failureCount} failed.`);
        }
      }
    } catch (error) {
      console.error('❌ Error in birthday cron job:', error.message);
    }
  });
};

module.exports = scheduleBirthdayCron;
