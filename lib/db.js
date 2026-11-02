const { MongoClient } = require('mongodb');
let client = null;
let db = null;

async function getDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI || "mongodb+srv://myanlearn:ZinThu357214@cluster0.8ybtscl.mongodb.net/myanlearn?retryWrites=true&w=majority";
  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000 });
    await client.connect();
  }
  db = client.db('myanlearn');
  return db;
}
async function getCollection(name) {
  const database = await getDB();
  return database.collection(name);
}
module.exports = { getDB, getCollection };