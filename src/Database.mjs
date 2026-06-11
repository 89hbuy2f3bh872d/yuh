import { MongoClient } from "mongodb";

let client = null;
let db     = null;

export async function connectDb(uri, dbName) {
  if (db) return db;
  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);
  const col = db.collection("users");
  await col.createIndex({ userId: 1 }, { unique: true });
  await col.createIndex({ balance: -1 });
  await col.createIndex({ totalWon: -1 });
  return db;
}

export function getDb() {
  if (!db) throw new Error("[Casino] MongoDB not connected yet.");
  return db;
}

export async function getOrCreate(userId, username) {
  const col = getDb().collection("users");
  const res = await col.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: { userId, balance: 1000, totalWon: 0, totalLost: 0, gamesPlayed: 0, dailyClaimed: 0 },
      $set: { username: username || "Unknown" }
    },
    { upsert: true, returnDocument: "after" }
  );
  return res;
}

export async function getBalance(userId) {
  const u = await getDb().collection("users").findOne({ userId }, { projection: { balance: 1 } });
  return u ? u.balance : null;
}

export async function addBalance(userId, delta) {
  await getDb().collection("users").updateOne({ userId }, { $inc: { balance: Math.floor(delta) } });
}

export async function recordResult(userId, won, lost) {
  await getDb().collection("users").updateOne(
    { userId },
    { $inc: { totalWon: Math.floor(won), totalLost: Math.floor(lost), gamesPlayed: 1 } }
  );
}

export async function transfer(fromId, toId, amount) {
  const col = getDb().collection("users");
  const from = await col.findOne({ userId: fromId });
  if (!from || from.balance < amount) throw new Error("Insufficient funds");
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await col.updateOne({ userId: fromId }, { $inc: { balance: -amount } }, { session });
      await col.updateOne({ userId: toId }, { $inc: { balance: amount } }, { session });
    });
  } finally {
    await session.endSession();
  }
}

export async function getLeaderboard(mode = "richest", limit = 10) {
  const col = getDb().collection("users");
  const sort = mode === "earners" ? { totalWon: -1 } : { balance: -1 };
  return col.find({}).sort(sort).limit(limit).toArray();
}

export async function claimDaily(userId) {
  const now = Date.now();
  const cooldown = 86400000;
  const col = getDb().collection("users");
  const user = await col.findOne({ userId });
  if (!user) return { ok: false, reason: "not_found" };
  if (now - (user.dailyClaimed || 0) < cooldown) {
    return { ok: false, reason: "cooldown", next: (user.dailyClaimed || 0) + cooldown };
  }
  const reward = 500 + Math.floor(Math.random() * 501);
  await col.updateOne({ userId }, { $inc: { balance: reward }, $set: { dailyClaimed: now } });
  return { ok: true, reward };
}

export function fmt(n) {
  return Number(n).toLocaleString("en-US");
}
