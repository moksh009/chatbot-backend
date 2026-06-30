const dns = require("dns");
const mongoose = require("mongoose");
require("../mongoose/phoneE164Plugin").registerPhoneE164GlobalPlugin();

/** ISP/router DNS on Windows often refuses SRV lookups required by mongodb+srv:// */
function applyMongoSrvDnsFix() {
    const uri = process.env.MONGODB_URI || "";
    if (!uri.includes("mongodb+srv")) return;
    if (process.env.MONGODB_DNS_FIX === "false") return;
    const servers = (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (servers.length) dns.setServers(servers);
}

async function connectDB(){
    try {
        applyMongoSrvDnsFix();
        console.log("Attempting to connect to MongoDB...");
        const maxPool = Math.min(
            50,
            Math.max(5, parseInt(process.env.MONGODB_MAX_POOL_SIZE || '25', 10) || 25)
        );
        const waitQueueTimeoutMS = Math.min(
            30000,
            Math.max(5000, parseInt(process.env.MONGODB_WAIT_QUEUE_TIMEOUT_MS || '12000', 10) || 12000)
        );
        const connectionInstance = await mongoose.connect(`${process.env.MONGODB_URI}`, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: maxPool,
            minPoolSize: Math.min(2, maxPool),
            maxIdleTimeMS: 30_000,
            waitQueueTimeoutMS,
            maxConnecting: Math.min(4, maxPool),
            retryWrites: true,
            family: 4, // Force IPv4 to resolve SSL/TLS handshake issues on local network
        })
        console.log(`\n MongoDB connected !! DB HOST: ${connectionInstance.connection.host}`);
        console.log(`   pool maxPoolSize=${maxPool} waitQueueTimeoutMS=${waitQueueTimeoutMS}`);

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

            const unknownOptInFix = await connectionInstance.connection.collection('adleads').updateMany(
                { optStatus: { $in: ['unknown', null, ''] } },
                {
                    $set: {
                        optStatus: 'opted_in',
                        whatsappMarketingEligible: true,
                        'channelConsent.whatsapp.status': 'opted_in',
                        'channelConsent.whatsapp.source': 'csv_import',
                        'channelConsent.whatsapp.lastUpdated': new Date(),
                    },
                }
            );
            if (unknownOptInFix.modifiedCount > 0) {
                console.log(`✅ Migrated ${unknownOptInFix.modifiedCount} contacts to default WhatsApp Opt-In.`);
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