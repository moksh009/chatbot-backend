require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');

const { runFullMigration } = require('./phase9MigrationLogic');

const processMigrate = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const result = await runFullMigration();
    console.log(`\n🎉 Migration complete. Updated ${result.updatedCount} clients.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
};

processMigrate();

processMigrate();
