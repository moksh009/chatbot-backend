const mongoose = require('mongoose');
const Client = require('../models/Client');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const createTestClinic = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const clientId = 'test_clinic_123';
        const email = 'clinic@test.com';

        // 1. Delete existing test data
        await Client.deleteOne({ clientId });
        await User.deleteOne({ email });

        // 2. Create Client (SaaS Tenant)
        const client = await Client.create({
            clientId,
            name: 'Generic Test Clinic',
            businessType: 'clinic',
            plan: 'CX Agent (V2)',
            whatsappToken: 'TEST_TOKEN',
            whatsappPhoneNumberId: '123456789',
            googleCalendarId: 'primary',
            nicheData: {
                welcomeMessage: 'Welcome to our Digital Clinic! 🏥 How can we help you today?',
                bannerImage: 'https://img.freepik.com/free-photo/medical-stethoscope-clipboard-resting-desk_23-2148519738.jpg',
                flowId: '1244048577247022', // Reusing Salon flow for testing structure
                screenId: 'HOLI_BOOKING_SCREEN',
                nextScreenId: 'TIME_AND_DETAILS_SCREEN',
                services: [
                    { id: 'svc_consult_gen', title: 'General Consultation', price: '₹500', duration: 30 },
                    { id: 'svc_consult_spec', title: 'Specialist Visit', price: '₹1200', duration: 45 },
                    { id: 'svc_blood_test', title: 'Full Blood Count', price: '₹800', duration: 15 }
                ],
                workingHours: {
                    start: '09:00',
                    end: '21:00'
                },
                slotDuration: 30,
                capacity: 2
            }
        });

        // 3. Create User (Dashboard Access)
        const hashedPassword = await bcrypt.hash('clinic123', 10);
        await User.create({
            name: 'Clinic Admin',
            email,
            password: hashedPassword,
            role: 'client',
            clientId,
            business_type: 'clinic'
        });

        console.log('✅ Test Clinic Provisioned Successfully!');
        console.log(`Email: ${email}`);
        console.log(`Password: clinic123`);
        console.log(`Client ID: ${clientId}`);

        process.exit(0);
    } catch (err) {
        console.error('Error provisioning test clinic:', err);
        process.exit(1);
    }
};

createTestClinic();
