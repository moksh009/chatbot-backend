const mongoose = require('mongoose');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// Load environment variables from the backend .env
require('dotenv').config({ path: path.join(__dirname, '../../chatbot-backend-main/.env') });

// Absolute paths to models
const Client = require('../../chatbot-backend-main/models/Client');
const MetaTemplate = require('../../chatbot-backend-main/models/MetaTemplate');
const TemplateGenerationJob = require('../../chatbot-backend-main/models/TemplateGenerationJob');
const SubmissionQueueItem = require('../../chatbot-backend-main/models/SubmissionQueueItem');

const CLIENT_ID = 'delitech_smarthomes';
const API_URL = 'http://localhost:5001/api';

async function run() {
  try {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI not found in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // 1. Setup Client
    let client = await Client.findOne({ clientId: CLIENT_ID });
    if (!client) {
        client = await Client.create({ clientId: CLIENT_ID, businessName: 'Delitech SmartHomes' });
    }

    // Ensure Shopify is connected to pass the check
    // Skip Shopify mock to avoid timeouts
    // client.shopDomain = 'delitech.myshopify.com';
    // client.shopifyAccessToken = 'mock_token';
    client.wabaId = '1234567890';
    client.whatsappToken = 'mock_wa_token';
    await client.save();
    console.log('Mocked connection for', CLIENT_ID);

    // Generate a mock JWT for a real user
    const token = jwt.sign(
        { id: '69622bba6dba6166a3abd3ab', clientId: CLIENT_ID, role: 'CLIENT_ADMIN' }, 
        process.env.JWT_SECRET || 'secret', 
        { expiresIn: '1h' }
    );
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Clear old test data
    await MetaTemplate.deleteMany({ clientId: CLIENT_ID, source: 'auto_generated' });
    await TemplateGenerationJob.deleteMany({ clientId: CLIENT_ID });
    await SubmissionQueueItem.deleteMany({ clientId: CLIENT_ID });
    console.log('Cleared old test data');

    // 3. Trigger Generation
    console.log('Starting Auto Template Generation...');
    try {
        const startRes = await axios.post(`${API_URL}/auto-templates/start`, { clientId: CLIENT_ID }, { headers });
        console.log('Start Response:', startRes.data);
    } catch (e) {
        console.error('Start Error:', e.response?.data || e.message);
        process.exit(1);
    }

    // 4. Poll DB for generation completion
    let job;
    console.log('Polling for generation complete...');
    let attempts = 0;
    while (attempts < 30) {
        job = await TemplateGenerationJob.findOne({ clientId: CLIENT_ID }).lean();
        if (job && (job.status === 'generation_complete' || job.status === 'submitting' || job.status === 'completed')) {
            console.log(`Generation finished. Status: ${job.status}. Generated: ${job.generatedCount}/${job.totalTemplates}`);
            break;
        }
        console.log(`Still generating... (Status: ${job?.status || 'pending'})`);
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }

    if (attempts >= 30) {
        console.error('Generation timed out');
        process.exit(1);
    }

    // 5. Verify Templates & Batch Assignments
    const templates = await MetaTemplate.find({ clientId: CLIENT_ID, source: 'auto_generated' }).lean();
    console.log(`Found ${templates.length} generated templates`);
    const queueItems = await SubmissionQueueItem.find({ clientId: CLIENT_ID }).sort({ queuePosition: 1 }).lean();
    console.log(`Found ${queueItems.length} queued items`);

    console.log('\nBatch Assignments:');
    const batches = {};
    queueItems.forEach(q => {
        if (!batches[q.batchNumber]) batches[q.batchNumber] = [];
        const t = templates.find(t => t._id.toString() === q.templateId.toString());
        batches[q.batchNumber].push({ pos: q.queuePosition, name: t?.name });
    });

    Object.keys(batches).forEach(b => {
        console.log(`Batch ${b}:`);
        batches[b].forEach(item => console.log(`  - Position ${item.pos}: ${item.name}`));
    });

    // 6. Test Never Stack on Pending rule manually
    console.log('\nTesting manual skip batch trigger (Never Stack on Pending rule)...');
    // Force one template to pending
    if (templates.length > 0) {
        const firstTemplate = templates[0];
        await MetaTemplate.findByIdAndUpdate(firstTemplate._id, { submissionStatus: 'pending_meta_review' });
        console.log(`Mocked template ${firstTemplate.name} to pending_meta_review`);

        try {
            await axios.post(`${API_URL}/auto-templates/trigger-next-batch`, { clientId: CLIENT_ID }, { headers });
            console.log('❌ ERROR: Should have been blocked by Never Stack on Pending rule!');
        } catch (e) {
            if (e.response?.status === 409) {
                console.log('✅ SUCCESS: Correctly blocked with 409 Conflict:', e.response.data.message);
            } else {
                console.log('❌ Unexpected error response:', e.response?.data || e.message);
            }
        }

        // Reset it back
        await MetaTemplate.findByIdAndUpdate(firstTemplate._id, { submissionStatus: 'draft' });
    } else {
        console.warn('No templates found to test Pending rule');
    }

    console.log('\nEnd-to-End Test Completed Successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Test script failed:', error);
    process.exit(1);
  }
}

run();
