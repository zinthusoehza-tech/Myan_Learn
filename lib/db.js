// lib/db.js — MongoDB connection (reuse client across serverless calls)
const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let indexesReady = false;

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set');
  client = new MongoClient(uri, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || undefined);
  return db;
}

async function ensureIndexes() {
  if (indexesReady) return;
  const d = await connect();
  try {
    await d.collection('users').createIndex({ username: 1 }, { unique: true });
    await d.collection('progress').createIndex({ username: 1, lessonId: 1 });
    await d.collection('progress').createIndex({ username: 1, day: 1 });
    await d.collection('content').createIndex({ kind: 1, lang: 1 });
  } catch (e) { /* ignore duplicate index errors */ }
  indexesReady = true;
}

async function getCollection(name) {
  await ensureIndexes();
  const d = await connect();
  return d.collection(name);
}

module.exports = { getCollection };
