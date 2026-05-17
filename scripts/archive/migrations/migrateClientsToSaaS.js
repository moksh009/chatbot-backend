const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

// Load env vars
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected for migration...'))
  .catch(err => console.error(err));

const migrateClients = async () => {
    try {
        console.log("Starting Migration of legacy clients to SaaS Architecture...");

        // 1. Choice Salon
        const choiceSalon = await Client.findOneAndUpdate(
            { clientId: 'choice_salon' },
            {
                $set: {
                    businessType: 'salon',
                    name: 'Choice Salon',
                    plan: 'CX Agent (V2)',
                    phoneNumberId: process.env.WHATSAPP_PHONENUMBER_ID || 'dummy',
                    whatsappToken: process.env.WHATSAPP_ACCESS_TOKEN || 'dummy',
                    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
                    isGenericBot: true, // IMPORTANT: Route to generic appointment
                    nicheData: {
                        welcomeMessage: "Welcome to Choice Salon! ✨ Would you like to book an appointment?",
                        services: [
                            { name: "Haircut + Styling", price: "500", duration: "60" },
                            { name: "Hair Spa", price: "1000", duration: "60" },
                            { name: "Premium Facial", price: "1500", duration: "60" }
                        ],
                        hours: {
                            0: { start: '10:00', end: '20:00', isClosed: false }, // Sunday
                            1: { start: '10:00', end: '20:00', isClosed: false }, // Monday
                            2: { start: '10:00', end: '20:00', isClosed: false },
                            3: { start: '10:00', end: '20:00', isClosed: false },
                            4: { start: '10:00', end: '20:00', isClosed: false },
                            5: { start: '10:00', end: '20:00', isClosed: false },
                            6: { start: '10:00', end: '20:00', isClosed: false } // Saturday
                        },
                        slotDuration: 60,
                        capacityPerSlot: 5
                    },
                    flowData: {
                        flowId: process.env.WHATSAPP_FLOW_ID || "852431420231652",
                        ctaButtonText: "Book Now",
                        faqReply: "Our experts are ready to transform your look.",
                        bookingConfirmationMsg: "Your appointment for {service} is confirmed for {date} at {time}!"
                    }
                }
            },
            { upsert: true, new: true }
        );
        console.log("Migrated Choice Salon:", choiceSalon._id);

        // 2. Delitech Smart Homes
        const delitech = await Client.findOneAndUpdate(
            { clientId: 'delitech_smarthomes' },
            {
                $set: {
                    businessType: 'ecommerce',
                    name: 'Delitech Smart Homes',
                    plan: 'CX Agent (V2)',
                    phoneNumberId: process.env.WHATSAPP_PHONENUMBER_ID || 'dummy',
                    whatsappToken: process.env.WHATSAPP_ACCESS_TOKEN || 'dummy',
                    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
                    isGenericBot: true, // Route to genericEcommerce
                    nicheData: {
                        welcomeMessage: "Hi there! Welcome to Delitech Smart Homes. How can we secure your home today?",
                        storeUrl: "https://delitechsmarthome.in",
                        products: [
                            { title: 'Delitech Smart Video Doorbell Pro (5MP)', price: '6999', shortDesc: '5MP Ultra HD • Smart AI • Anti-Theft', image: 'https://delitechsmarthome.in/cdn/shop/files/my1.png', url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp' },
                            { title: 'Delitech Smart Video Doorbell Plus (3MP)', price: '6499', shortDesc: '2K Crisp Video • Color Night Vision', image: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png', url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp' },
                            { title: 'Delitech Smart Video Doorbell (2MP)', price: '5499', shortDesc: 'Standard HD Video • 2-Way Talk', image: 'https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png', url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-2mp' }
                        ],
                        aiPromptContext: "You are a friendly sales assistant for Delitech Smart Home. Our doorbells feature 100% wireless DIY setup and IP65 waterproofing.",
                        paymentGateway: {
                            cashfree: {
                                app_id: process.env.CASHFREE_APP_ID || "",
                                secret_key: process.env.CASHFREE_SECRET_KEY || ""
                            }
                        }
                    },
                    flowData: {
                        ctaButtonText: "Shop Doorbells",
                        faqReply: "Let me fetch the answer for your query.",
                        orderConfirmationMsg: "Thank you for shopping with Delitech, {name}! Your order for {items} is confirmed.",
                        abandonedCartMsg1: "Hi {name}! You left {items} in your cart. Claim your free shipping today: {cart_link}"
                    }
                }
            },
            { upsert: true, new: true }
        );
        console.log("Migrated Delitech:", delitech._id);

        // 3. Turf
        const turf = await Client.findOneAndUpdate(
            { clientId: 'turf' },
            {
                $set: {
                    businessType: 'turf',
                    name: 'TopEdge Turf',
                    plan: 'CX Agent (V1)', 
                    isGenericBot: false,
                    nicheData: {
                        pricing: { hourly: 1000 },
                        hours: {
                            start: '06:00',
                            end: '22:00'
                        }
                    }
                }
            },
            { upsert: true, new: true }
        );
        console.log("Migrated Turf:", turf._id);

        console.log("Migration Complete! Extracted hardcoded rules into `nicheData` JSON blocks.");
        process.exit(0);

    } catch (error) {
        console.error("Migration Error:", error);
        process.exit(1);
    }
};

migrateClients();
