const Client = require("../models/Client");
const AdLead = require("../models/AdLead");
const CustomerWallet = require("../models/CustomerWallet");
const LoyaltyTransaction = require("../models/LoyaltyTransaction");

async function awardLoyaltyPoints({ clientId, phone, orderId, orderAmount, isBackfill = false }) {
  try {
    // 1. Get loyalty config
    const client = await Client.findOne({ clientId }).select("loyaltyConfig").lean();
    const config = client?.loyaltyConfig;
    const loyaltyEnabled = config?.isEnabled ?? config?.enabled;
    if (!loyaltyEnabled) return { skipped: true, reason: "Loyalty disabled" };

    if (!phone) return { skipped: true, reason: "No phone specified" };

    // 2. Check if already awarded
    const suffix = phone.slice(-10);
    const alreadyAwarded = await LoyaltyTransaction.findOne({
      clientId,
      phone: { $regex: suffix + "$" },
      orderId,
      type: { $in: ["earn", "backfill"] }
    });

    if (alreadyAwarded) return { skipped: true, reason: "Already awarded" };

    // 3. Calculate points
    const currencyUnit = config.currencyUnit || 100;
    const pointsPerUnit = config.pointsPerUnit || 10;
    const points = Math.floor((orderAmount / currencyUnit) * pointsPerUnit);

    if (points <= 0) return { skipped: true, reason: "No points to award" };

    // 4. Find or create wallet
    const digits = phone.replace(/\D/g, "");
    
    let wallet = await CustomerWallet.findOne({
      clientId,
      phone: { $regex: suffix + "$" }
    });

    if (!wallet) {
      wallet = await CustomerWallet.create({
        clientId,
        phone: digits,
        balance: 0,
        lifetimePoints: 0,
        tier: "Bronze"
      });
    }

    // 5. Update balance atomically
    const updatedWallet = await CustomerWallet.findByIdAndUpdate(
      wallet._id,
      {
        $inc: { balance: points, lifetimePoints: points },
        $set: { updatedAt: new Date() }
      },
      { new: true }
    );

    // 6. Determine tier
    const tiers = config.tiers || [
      { name: "Bronze", threshold: 0 },
      { name: "Silver", threshold: 500 },
      { name: "Gold", threshold: 2000 },
      { name: "Platinum", threshold: 5000 }
    ];

    const newTier = [...tiers]
      .sort((a, b) => b.threshold - a.threshold)
      .find(t => updatedWallet.lifetimePoints >= t.threshold);

    if (newTier && newTier.name !== wallet.tier) {
      await CustomerWallet.findByIdAndUpdate(wallet._id, {
        $set: { tier: newTier.name }
      });
      updatedWallet.tier = newTier.name;
    }

    // 7. Record transaction
    await LoyaltyTransaction.create({
      clientId,
      phone: digits,
      orderId,
      type: isBackfill ? "backfill" : "earn",
      amount: points,
      reason: `Order ${orderId} — ₹${orderAmount}`,
      balanceAfter: updatedWallet.balance,
      timestamp: new Date()
    });

    return { success: true, points, newBalance: updatedWallet.balance };
  } catch (err) {
    console.error("[LoyaltyEngine] award error:", err.message);
    return { success: false, error: err.message };
  }
}

async function sendReminder({ clientId, phone }) {
    const client = await Client.findOne({ clientId }).select("loyaltyConfig phoneNumberId whatsappToken syncedMetaTemplates configuration").lean();

    const digits = phone.replace(/\D/g, "");
    const suffix = digits.slice(-10);
    
    let wallet = await CustomerWallet.findOne({
      clientId,
      phone: { $regex: suffix + "$" }
    });

    if (!wallet || wallet.balance === 0) throw new Error("Wallet not found or empty");
    
    let lead = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();

    const template = client.syncedMetaTemplates?.find(t =>
      t.name.includes("loyalty") && t.status === "APPROVED"
    );

    if (!template) throw new Error("No approved loyalty template found");

    const currencyUnit = client.loyaltyConfig?.currencyUnit || 100;
    const pointsPerUnit = client.loyaltyConfig?.pointsPerUnit || 10;
    const pointsValue = Math.floor((wallet.balance / pointsPerUnit) * currencyUnit);

    const { sendWhatsAppTemplate } = require("./whatsapp");
    await sendWhatsAppTemplate({
        phoneNumberId: client.phoneNumberId,
        to: phone,
        templateName: template.name,
        bodyVariables: [lead?.name || "Customer", wallet.balance.toString(), pointsValue.toString(), wallet.tier],
        token: client.whatsappToken
    });

    return { success: true };
}

module.exports = { awardLoyaltyPoints, sendReminder };
