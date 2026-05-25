const mongoose = require('mongoose');

let mongod = null;

async function startMemoryMongo() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongod.waitUntilRunning();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  return uri;
}

async function stopMemoryMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

async function clearCollections(modelNames = []) {
  const names =
    modelNames.length > 0
      ? modelNames
      : Object.keys(mongoose.connection.models);
  for (const name of names) {
    const model = mongoose.connection.models[name];
    if (model) await model.deleteMany({}, { bypassClientScope: true });
  }
}

module.exports = { startMemoryMongo, stopMemoryMongo, clearCollections };
