require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const AdLead = require('./models/AdLead');
const Client = require('./models/Client');

// Function to send WhatsApp template
async function sendWhatsAppTemplate(token, phoneId, to, templateName, variables) {
    // Simulated or actual sending
}

async function runTest() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        const now = new Date();
        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

        // 1. Find the most recently active cart
        const recentLead = await AdLead.findOne({
            cartStatus: 'active'
        }).sort({ lastInteraction: -1 });

        if (!recentLead) {
            console.log("❌ No active lead found to test.");
            process.exit(0);
        }

        console.log(`🔍 Found recent lead: ${recentLead.phoneNumber} (Name: ${recentLead.name || 'N/A'})`);

        // 2. Backdate the cart to simulate 2 hours passing
        const simulatedPastTime = new Date(now.getTime() - (2 * 60 * 60 * 1000) - (60 * 1000)); // 2 hours and 1 minute ago
        await AdLead.findByIdAndUpdate(recentLead._id, {
            addToCartCount: 1,
            'cartSnapshot.updatedAt': simulatedPastTime,
            'cartSnapshot.titles': ['Smart Home Hub Test Item'],
            'cartSnapshot.items': [{ variant_id: 'test_variant_123', quantity: 1 }]
        });
        console.log(`⏳ Backdated cartSnapshot.updatedAt to ${simulatedPastTime} to trigger cron.`);

        // 3. Execute cron logic
        console.log("🚀 Executing Abandoned Cart Cron Logic...");

        const clients = await Client.find({ businessType: 'ecommerce' });
        for (const client of clients) {
            const token = client.whatsappToken;
            const phoneId = client.phoneNumberId;

            if (!token || !phoneId) continue;

            const abandonedLeads = await AdLead.find({
                clientId: client.clientId,
                cartStatus: 'active',
                addToCartCount: { $gt: 0 },
                $or: [{ checkoutInitiatedCount: 0 }, { checkoutInitiatedCount: { $exists: false } }],
                'cartSnapshot.updatedAt': { $lte: twoHoursAgo }
            });

            console.log(`📦 Found ${abandonedLeads.length} abandoned leads for client ${client.clientId}.`);

            for (const lead of abandonedLeads) {
                const customerName = lead.name || 'Valued Customer';
                console.log(`✉️ Seding template 'abandoned_cart_reminder' to +${lead.phoneNumber}...`);

                const variables = [
                    { type: 'text', text: customerName } // {{1}}
                ];

                const templateData = {
                    messaging_product: 'whatsapp',
                    to: lead.phoneNumber,
                    type: 'template',
                    template: {
                        name: 'abandoned_cart_reminder',
                        language: { code: 'en' },
                        components: [
                            {
                                type: 'body',
                                parameters: variables
                            },
                            {
                                type: 'button',
                                sub_type: 'url',
                                index: '0',
                                parameters: [{ type: 'text', text: lead._id.toString() }]
                            }
                        ]
                    }
                };

                let success = false;
                try {
                    const res = await axios.post(
                        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
                        templateData,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    success = true;
                    console.log(`✅ Message sent successfully! Message ID: ${res.data.messages[0].id}`);
                } catch (e) {
                    console.error("❌ WhatsApp Template Error:", e.response?.data || e.message);
                }

                if (success) {
                    await AdLead.findByIdAndUpdate(lead._id, {
                        $set: {
                            cartStatus: 'abandoned',
                            abandonedCartReminderSentAt: new Date()
                        },
                        $push: {
                            activityLog: {
                                action: 'whatsapp_template_sent',
                                details: 'Sent abandoned_cart_reminder template (TEST SCRIPT)',
                                timestamp: new Date()
                            }
                        }
                    });
                    console.log(`✅ Updated lead ${lead._id} status to 'abandoned'`);
                } else {
                    await AdLead.findByIdAndUpdate(lead._id, {
                        $push: {
                            activityLog: {
                                action: 'whatsapp_failed',
                                details: 'Failed to send abandoned_cart_reminder template (TEST SCRIPT)',
                                timestamp: new Date()
                            }
                        }
                    });
                    console.log(`⚠️ Logged whatsapp_failed for lead ${lead._id}`);
                }
            }
        }

        console.log("🎉 Test completed.");
        process.exit(0);

    } catch (err) {
        console.error("Test Error:", err);
        process.exit(1);
    }
}

runTest();
