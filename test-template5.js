const axios = require('axios');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('./models/Client');

dotenv.config();

async function testTemplate() {
    await mongoose.connect(process.env.MONGODB_URI);

    const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
    const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    const templateData = {
        "messaging_product": "whatsapp",
        "to": "919313045439",
        "type": "template",
        "template": {
            "name": "abandoned_cart_remind",
            "language": {
                "code": "en_US"
            },
            "components": [
                {
                    "type": "header",
                    "parameters": [
                        {
                            "type": "image",
                            "image": {
                                "link": "https://www.delitech.in/cdn/shop/files/WhatsAppImage2024-03-24at1.25.10PM.jpg"
                            }
                        }
                    ]
                },
                {
                    "type": "body",
                    "parameters": [
                        {
                            "type": "text",
                            "text": "Moksh"
                        }
                    ]
                },
                {
                    "type": "button",
                    "sub_type": "url",
                    "index": "0",
                    "parameters": [
                        {
                            "type": "text",
                            "text": "6989b81c1c9422a570a6c161?uid=6989b81c1c9422a570a6c161&restore=true"
                        }
                    ]
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
