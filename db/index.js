const mongoose = require("mongoose");


async function connectDB(){
    try {
        const connectionInstance = await mongoose.connect(`${process.env.MONGODB_URI}`)
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