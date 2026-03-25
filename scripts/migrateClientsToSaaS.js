const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

// Load env vars
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected for migration...'))
  .catch(err => console.error(err));

const migrateClients = async () => {
    try {
        console.log("Starting Migration of legacy clients to SaaS Architecture...");

        // 1. Choice Salon (Holi/V2)
        const choiceSalon = await Client.findOneAndUpdate(
            { clientId: 'choice_salon' },
            {
                $set: {
                    businessType: 'salon',
                    name: 'Choice Salon',
                    plan: 'CX Agent (V2)',
                    isGenericBot: true, // IMPORTANT: Route to generic appointment
                    nicheData: {
                        timezone: 'Asia/Kolkata',
                        services: [
                            { id: "1", name: "Haircut", price: 500, duration: 60 },
                            { id: "2", name: "Hair Spa", price: 1000, duration: 60 },
                            { id: "3", name: "Facial", price: 1500, duration: 60 },
                            { id: "4", name: "Bridal Makeup", price: 5000, duration: 120 }
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
                        flowId: process.env.WHATSAPP_FLOW_ID || "852431420231652", // choice salon flow ID
                        welcomeMessage: "Welcome to Choice Salon! ✨ Would you like to book an appointment?",
                        ctaButtonText: "Book Now"
                    }
                }
            },
            { upsert: true, new: true }
        );
        console.log("Migrated Choice Salon:", choiceSalon._id);

        // 2. Ved (Ecommerce)
        const ved = await Client.findOneAndUpdate(
            { clientId: 'ved' },
            {
                $set: {
                    businessType: 'ecommerce',
                    name: 'Delitech Smart Home',
                    plan: 'CX Agent (V2)',
                    isGenericBot: true, // Route to genericEcommerce
                    nicheData: {
                        storeUrl: "https://delitechsmarthome.in",
                        products: [
                            { id: "prod_1", title: "Smart Doorbell X1", price: "2999" },
                            { id: "prod_2", title: "Smart Lock Beta", price: "5999" }
                        ],
                        aiPromptContext: "You are a friendly sales assistant for Delitech Smart Home, a premium electronics company. We sell smart doorbells.",
                        paymentGateway: {
                            cashfree: {
                                app_id: process.env.CASHFREE_APP_ID || "",
                                secret_key: process.env.CASHFREE_SECRET_KEY || ""
                            }
                        }
                    }
                }
            },
            { upsert: true, new: true }
        );
        console.log("Migrated Ved (Ecommerce):", ved._id);

        // 3. Turf
        const turf = await Client.findOneAndUpdate(
            { clientId: 'turf' },
            {
                $set: {
                    businessType: 'turf',
                    name: 'TopEdge Turf',
                    plan: 'CX Agent (V1)', 
                    isGenericBot: false, // Keep false if turf.js hasn't been merged to generic yet
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
