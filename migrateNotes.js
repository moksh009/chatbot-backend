require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');
const ConversationNote = require('./models/ConversationNote');

async function migrate() {
    await connectDB();
    console.log("Connected to MongoDB");

    // We use .collection to bypass mongoose schema restrictions (since internalNotes field was removed from schema)
    const conversations = await mongoose.connection.collection('conversations').find({ 
        internalNotes: { $exists: true, $not: { $size: 0 } }
    }).toArray();

    console.log(`Found ${conversations.length} conversations with embedded notes.`);
    let migratedCount = 0;

    for (const conv of conversations) {
        for (const note of conv.internalNotes) {
            await ConversationNote.updateOne(
                { conversationId: conv._id, content: note.content, createdAt: note.createdAt },
                { 
                    $set: {
                        conversationId: conv._id,
                        clientId: conv.clientId,
                        content: note.content,
                        authorId: note.authorId,
                        authorName: note.authorName || 'System',
                        createdAt: note.createdAt || new Date()
                    }
                },
                { upsert: true }
            );
            migratedCount++;
        }
    }

    console.log(`Migrated ${migratedCount} notes successfully.`);
    
    // Optionally remove internalNotes array from original docs
    await mongoose.connection.collection('conversations').updateMany(
        { internalNotes: { $exists: true } },
        { $unset: { internalNotes: "" } }
    );
    console.log("Cleared old internalNotes arrays from conversations.");

    process.exit(0);
}

migrate().catch(console.error);
