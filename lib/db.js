// lib/db.js — MongoDB connection (reuse one client across serverless calls)
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  client = new MongoClient(process.env.MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || undefined);
  return db;
}

async function getCollection(name) {
  const d = await connect();
  return d.collection(name);
}

module.exports = { getCollection };
