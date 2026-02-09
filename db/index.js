const mongoose = require("mongoose");


async function connectDB(){
    try {
        console.log("Attempting to connect to MongoDB...");
        const connectionInstance = await mongoose.connect(`${process.env.MONGODB_URI}`, {
            serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
            socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
        })
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
        } catch (idxErr) {
            console.log("ℹ️ Index cleanup check passed/skipped:", idxErr.message);
        }
        // ----------------------------------------------------------

    } catch (error) {
        console.log("MONGODB connection FAILED ", error);
        process.exit(1)
    }
}

module.exports=connectDB;