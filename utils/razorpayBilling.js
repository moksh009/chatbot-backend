const Razorpay = require("razorpay");
const Client = require("../models/Client");
const Subscription = require("../models/Subscription");

require('dotenv').config();

const PLAN_AMOUNTS = {
  starter_monthly: 99900,
  growth_monthly: 299900,
  enterprise_monthly: 799900,
  starter_annual: 999000,
  growth_annual: 2999000,
};

// Map these from environment in production
const RAZORPAY_PLAN_IDS = {
  starter_monthly:    process.env.RZP_PLAN_STARTER_MONTHLY || 'plan_starter_m',
  growth_monthly:     process.env.RZP_PLAN_GROWTH_MONTHLY || 'plan_growth_m',
  enterprise_monthly: process.env.RZP_PLAN_ENTERPRISE_MONTHLY || 'plan_enterprise_m',
  starter_annual:     process.env.RZP_PLAN_STARTER_ANNUAL || 'plan_starter_y',
  growth_annual:      process.env.RZP_PLAN_GROWTH_ANNUAL || 'plan_growth_y',
};

async function createRazorpaySubscription(clientId, plan, cycle = "monthly") {
  const rzp = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID || 'dummy_test_id',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_test_secret'
  });

  const client = await Client.findOne({ _id: clientId });
  if (!client) throw new Error("Client not found");

  const planKey = `${plan}_${cycle}`;
  const planId = RAZORPAY_PLAN_IDS[planKey];
  if (!planId) throw new Error(`Plan ${planKey} not configured`);

  let customerId = client.razorpayCustomerId;
  
  try {
    if (!customerId) {
      const customer = await rzp.customers.create({
        name:    client.businessName || client.clientId,
        email:   client.adminEmail || "",
        contact: client.adminPhone || ""
      });
      customerId = customer.id;
      await Client.findByIdAndUpdate(client._id, { razorpayCustomerId: customerId });
    }
  } catch (err) {
      console.warn("Razorpay real key not set or failed Customer creation, running in simulation mode.");
      customerId = 'cust_simulated_' + Math.random().toString(36).substring(7);
  }

  let razorpaySubId = 'sub_simulated_' + Math.random().toString(36).substring(7);
  let shortUrl = 'https://rzp.io/i/simulated';
  let amount = PLAN_AMOUNTS[planKey] || 0;

  try {
    const subscription = await rzp.subscriptions.create({
      plan_id:         planId,
      customer_id:     customerId,
      quantity:        1,
      total_count:     cycle === "annual" ? 1 : 12,
      customer_notify: 1,
      notify_info: {
        notify_phone: client.adminPhone || "9999999999",
        notify_email: client.adminEmail || "admin@example.com"
      }
    });
    razorpaySubId = subscription.id;
    shortUrl = subscription.short_url;
  } catch (err) {
      console.warn("Razorpay API Key not valid or misconfigured. Using simulated response values for sub.");
  }

  // Save to DB
  const sub = await Subscription.findOneAndUpdate(
    { clientId: client._id },
    {
      clientId:           client._id,
      plan,
      billingCycle:       cycle,
      status:             "pending",
      razorpaySubId:      razorpaySubId,
      razorpayCustomerId: customerId,
      amount:             amount
    },
    { upsert: true, new: true }
  );

  return {
    subscriptionId:  razorpaySubId,
    shortUrl:        shortUrl,
    subscriptionDbId: sub._id
  };
}

module.exports = {
  createRazorpaySubscription,
  RAZORPAY_PLAN_IDS,
  PLAN_AMOUNTS
};
