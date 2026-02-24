require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('./models/Client');
const axios = require('axios');
const connectDB = require('./db');

async function sendTemplates() {
    try {
        await connectDB();
        console.log('Connected to DB');

        // We need the choice_salon client
        const client = await Client.findOne({ businessType: 'choice_salon' });
        if (!client) {
            console.log('No choice_salon client found');
            process.exit(1);
        }

        console.log('Found client:', client.clientId, client.name);

        const token = client.whatsappToken;
        const phoneNumberId = client.phoneNumberId;

        // The two specific test numbers provided by the user
        const testNumbers = ['916353306984', '919313045439'];

        for (const number of testNumbers) {
            try {
                const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
                const data = {
                    messaging_product: 'whatsapp',
                    to: number,
                    type: 'template',
                    template: {
                        name: 'holi_offer_1',
                        language: {
                            code: 'en'
                        }
                    }
                };

                const res = await axios.post(url, data, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    }
                });
                console.log(`✅ Successfully sent Holi Promo to ${number}:`, res.data);
            } catch (error) {
                console.error(`❌ Failed to send to ${number}:`, error.response?.data?.error || error.message);

                // Retry with en_US if language error occurs
                if (error.response?.data?.error?.message?.includes('language')) {
                    console.log('Retrying with en_US...');
                    try {
                        const data2 = {
                            messaging_product: 'whatsapp',
                            to: number,
                            type: 'template',
                            template: {
                                name: 'holi_offer_1',
                                language: {
                                    code: 'en_US'
                                }
                            }
                        };

                        const res2 = await axios.post(url, data2, {
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            }
                        });
                        console.log(`✅ Successfully sent Holi Promo (en_US) to ${number}:`, res2.data);
                    } catch (err2) {
                        console.error(`❌ Failed retry for ${number}:`, err2.response?.data?.error || err2.message);
                    }
                }
            }
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

sendTemplates();
