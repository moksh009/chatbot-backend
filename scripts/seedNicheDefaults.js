const mongoose = require('mongoose');
const Client = require('../models/Client');
const dotenv = require('dotenv');
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://mokshp607:Moksh2003@cluster0.p71f5.mongodb.net/chatbot?retryWrites=true&w=majority&appName=Cluster0';

const DEFAULT_ECOMMERCE = {
    welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best smart home products and more. How can we assist you today?",
    bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
    flowButtonText: "Shop Now 🛍️",
    supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
    orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
    abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order? Prices are rising soon! ⏳",
    abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now and get a 5% discount on your next order! click below to restore cart.",
    storeUrl: "https://delitechsmarthomes.com",
    googleReviewUrl: "https://g.page/r/your-id/review"
};

const DEFAULT_SALON = {
    welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium hair spa, advanced coloring, or precision cuts. How can we pamper you today?",
    bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
    flowButtonText: "Book Appointment 📅",
    supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
    orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you at the salon! ✨",
    abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot before they are all gone?",
    abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now and enjoy a relaxing session with our master stylists!",
    websiteUrl: "https://your-salon.com",
    googleReviewUrl: "https://g.page/r/your-id/review",
    calendars: {
        "Main Stylist": "abc@group.calendar.google.com"
    },
    services: [
        { name: "Haircut", price: "500", duration: "30" },
        { name: "Hair Spa", price: "1200", duration: "60" }
    ]
};

async function seed() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        const clients = await Client.find({});
        let updated = 0;

        for (const client of clients) {
            let isModified = false;
            // More thorough check: if nicheData is null, undefined, or empty object {}
            if (!client.nicheData || Object.keys(client.nicheData).length === 0) {
                if (client.businessType === 'ecommerce' || client.clientId.includes('ecommerce') || client.clientId.includes('smarthomes')) {
                    client.nicheData = { ...DEFAULT_ECOMMERCE };
                    isModified = true;
                } else {
                    client.nicheData = { ...DEFAULT_SALON };
                    isModified = true;
                }
            }

            if (isModified) {
                await client.save();
                updated++;
                console.log(`Seeded defaults for: ${client.clientId} (${client.businessType})`);
            }
        }

        console.log(`Migration Complete: ${updated} clients updated.`);
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

seed();
