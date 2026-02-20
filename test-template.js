const axios = require('axios');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('./models/Client');
const AdLead = require('./models/AdLead');

dotenv.config();

async function testTemplate() {
    await mongoose.connect(process.env.MONGODB_URI);

    const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
    const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    const lead = await AdLead.findOne({ phoneNumber: { $regex: /919313045439$/ } });

    const customerName = lead.name || 'Valued Customer';
    const variables = [{ type: 'text', text: customerName }];
    const imageUrl = lead.cartSnapshot?.items?.[0]?.image || 'https://www.delitech.in/cdn/shop/files/WhatsAppImage2024-03-24at1.25.10PM.jpg';

    const restoreUrlSuffix = `${lead._id.toString()}?uid=${lead._id.toString()}&restore=true`;

    const templateData = {
        messaging_product: 'whatsapp',
        to: lead.phoneNumber,
        type: 'template',
        template: {
            name: 'abandoned_cart_remind',
            language: { code: 'en' },
            components: [
                {
                    type: 'header',
                    parameters: [
                        {
                            type: 'image',
                            image: {
                                link: imageUrl
                            }
                        }
                    ]
                },
                {
                    type: 'body',
                    parameters: variables
                },
                {
                    type: 'button',
                    sub_type: 'url',
                    index: '0',
                    parameters: [{ type: 'text', text: restoreUrlSuffix }]
                }
            ]
        }
    };

    try {
        console.log('Sending payload:', JSON.stringify(templateData, null, 2));
        const res = await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            templateData,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('Success:', res.data);
    } catch (e) {
        console.error('Error:', e.response?.data || e.message);
    }

    mongoose.disconnect();
}

testTemplate();
