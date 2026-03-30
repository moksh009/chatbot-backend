const mongoose = require("mongoose");

async function connectDB() {
    try {
        console.log("Attempting to connect to MongoDB...");
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) {
            console.error("❌ FATAL: No MongoDB URI found (MONGO_URI or MONGODB_URI)");
            process.exit(1);
        }

        const connectionInstance = await mongoose.connect(uri, {
            // ── Connection Pool (Phase 16) ──────────────────────────────
            maxPoolSize:  20,   // Max simultaneous connections
            minPoolSize:   5,   // Keep 5 warm at all times

            // ── Timeouts ────────────────────────────────────────────────
            connectTimeoutMS:            10000,  // Fail fast on initial connect
            socketTimeoutMS:             45000,  // Allow longer queries
            serverSelectionTimeoutMS:    10000,  // Replica set selection timeout

            // ── Behavior ────────────────────────────────────────────────
            bufferCommands:  false,  // Fail immediately if not connected (no queue)
            readPreference: "primaryPreferred",
        });
        console.log(`\n MongoDB connected !! DB HOST: ${connectionInstance.connection.host}`);

        // --- AUTO-FIX: Drop conflicting legacy index on adleads ---
        try {
            const collection = connectionInstance.connection.collection('adleads');
            const indexes = await collection.indexes();
            const legacyIndex = indexes.find(idx => idx.name === 'phoneNumber_1');
            
            if (legacyIndex) {
                console.log("⚠️ Found legacy unique index 'phoneNumber_1'. Dropping it to allow multi-client leads...");
                await collection.dropIndex('phoneNumber_1');
                console.log("✅ Successfully dropped conflicting index.");
            }

            // --- AUTO-FIX: Reset leads with 'failed' status to 'active' ---
            const failedLeads = await connectionInstance.connection.collection('adleads').countDocuments({ cartStatus: 'failed' });
            if (failedLeads > 0) {
                console.log(`⚠️ Found ${failedLeads} leads with 'failed' status. Resetting to 'active' for recovery...`);
                await connectionInstance.connection.collection('adleads').updateMany(
                    { cartStatus: 'failed' },
                    { 
                        $set: { cartStatus: 'active' },
                        $unset: { abandonedCartReminderSentAt: "" } 
                    }
                );
                console.log("✅ Successfully reset failed leads.");
            }
        } catch (idxErr) {
            console.log("ℹ️ Database auto-fix check passed/skipped:", idxErr.message);
        }
        // ----------------------------------------------------------

    } catch (error) {
        console.log("MONGODB connection FAILED ", error);
        process.exit(1)
    }
}

module.exports=connectDB;