const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
const { sendEmail } = require('../utils/emailService');
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

const hydrateContent = (content, lead, client) => {
    if (!content) return "";
    let hydrated = content;

    // Standard Variables
    hydrated = hydrated.replace(/{{name}}/g, lead?.name || "there");
    hydrated = hydrated.replace(/{{first_name}}/g, lead?.name?.split(' ')[0] || "there");
    hydrated = hydrated.replace(/{{store_name}}/g, client?.name || "our store");

    // Cart Variables
    if (lead?.cartSnapshot?.items?.length > 0 || lead?.cartItems?.length > 0) {
        const items = lead.cartSnapshot?.items || lead.cartItems || [];
        const cartUrl = lead.cartUrl || lead.cartSnapshot?.url || "#";
        const cartTotal = lead.cartValue || 0;

        // Generate Premium HTML Table for Cart Items
        const itemsHtml = items.map(item => `
            <div style="display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid #f1f5f9;">
                <img src="${item.image || "https://via.placeholder.com/100"}" alt="${item.title || "Product"}" style="width: 80px; height: 80px; border-radius: 12px; object-fit: cover; border: 1px solid #e2e8f0;" />
                <div style="flex: 1;">
                    <p style="margin: 0; font-size: 14px; font-weight: 700; color: #0f172a;">${item.title || "Selected Item"}</p>
                    <p style="margin: 4px 0 0; font-size: 12px; font-weight: 500; color: #64748b;">Qty: ${item.quantity || 1}</p>
                    <p style="margin: 4px 0 0; font-size: 14px; font-weight: 800; color: #6d28d9;">₹${item.price || ""}</p>
                </div>
            </div>
        `).join('');

        const cartBlock = `
            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px; padding: 24px; margin: 24px 0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05);">
                <p style="margin: 0 0 16px; font-size: 10px; font-weight: 900; letter-spacing: 0.1em; color: #94a3b8; text-transform: uppercase;">YOUR RESERVED ITEMS</p>
                ${itemsHtml}
                <div style="margin-top: 20px; display: flex; justify-content: space-between; align-items: center;">
                    <p style="margin: 0; font-size: 14px; font-weight: 600; color: #64748b;">Subtotal</p>
                    <p style="margin: 0; font-size: 18px; font-weight: 900; color: #0f172a;">₹${cartTotal}</p>
                </div>
            </div>
        `;

        hydrated = hydrated.replace(/{{cart_items_html}}/g, cartBlock);
        hydrated = hydrated.replace(/{{cart_url}}/g, cartUrl);
        hydrated = hydrated.replace(/{{cart_total}}/g, cartTotal);
    } else {
        // Fallback for missing cart data
        hydrated = hydrated.replace(/{{cart_items_html}}/g, `<div style="padding: 20px; border: 1px dashed #cbd5e1; border-radius: 16px; text-align: center; color: #94a3b8; font-size: 12px;">Your selected items are waiting for you.</div>`);
        hydrated = hydrated.replace(/{{cart_url}}/g, "#");
        hydrated = hydrated.replace(/{{cart_total}}/g, "0");
    }

    return hydrated;
};

const scheduleFollowUpSequenceCron = () => {
    // Run every 5 minutes
    cron.schedule("*/5 * * * *", async () => {
        try {
            const now = new Date();
            const sequences = await FollowUpSequence.find({
                status: "active",
                "steps.status": "pending",
                "steps.sendAt": { $lte: now }
            });

            console.log(`[SequenceCron] Found ${sequences.length} sequences with due steps.`);

            for (const seq of sequences) {
                const dueStep = seq.steps.find(s => s.status === "pending" && s.sendAt <= now);
                if (!dueStep) continue;

                const [client, lead] = await Promise.all([
                    Client.findOne({ clientId: seq.clientId }),
                    AdLead.findById(seq.leadId)
                ]);

                if (!client) {
                    dueStep.status = "failed";
                    dueStep.errorLog = "Client not found";
                    await seq.save();
                    continue;
                }

                let sentSuccess = false;
                let errorMessage = "";

                // Hydrate content with lead data
                const hydratedContent = hydrateContent(dueStep.content, lead, client);
                const hydratedSubject = hydrateContent(dueStep.subject, lead, client);

                if (dueStep.type === 'whatsapp') {
                    if (!client.whatsappToken || !client.phoneNumberId) {
                        errorMessage = "WhatsApp not configured";
                    } else {
                        const token = decrypt(client.whatsappToken);
                        const phoneId = client.phoneNumberId;

                        if (dueStep.templateName) {
                            const res = await sendWhatsAppTemplate({
                                phoneNumberId: phoneId,
                                to: seq.phone,
                                templateName: dueStep.templateName,
                                token: token
                            });
                            sentSuccess = res.success;
                            errorMessage = res.error || "";
                        } else {
                            const res = await sendWhatsAppText({
                                phoneNumberId: phoneId,
                                to: seq.phone,
                                body: hydratedContent,
                                token: token
                            });
                            sentSuccess = res.success;
                            errorMessage = res.error || "";
                        }
                    }
                } else if (dueStep.type === 'email') {
                    if (!seq.email && !lead?.email) {
                        errorMessage = "No email address for lead";
                    } else {
                        const success = await sendEmail(client, {
                            to: seq.email || lead?.email,
                            subject: hydratedSubject || "A message from our store",
                            html: hydratedContent
                        });
                        sentSuccess = success;
                        if (!success) errorMessage = "Email sending failed";
                    }
                }

                if (sentSuccess) {
                    dueStep.status = "sent";
                    dueStep.sentAt = new Date();
                    dueStep.errorLog = "";
                } else {
                    dueStep.status = "failed";
                    dueStep.errorLog = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
                }

                const stillPending = seq.steps.some(s => s.status === "pending");
                if (!stillPending) seq.status = "completed";

                await seq.save();
            }
        } catch (err) {
            console.error('❌ Error in follow-up sequence cron:', err);
        }
    });
};

module.exports = scheduleFollowUpSequenceCron;
