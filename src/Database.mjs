import { MongoClient } from "mongodb";

export class Database {
  constructor(uri, dbName = "casino") {
    this._uri = uri;
    this._dbName = dbName;
    this._client = null;
    this._db = null;
  }

  async connect() {
    this._client = new MongoClient(this._uri);
    await this._client.connect();
    this._db = this._client.db(this._dbName);
    this._users = this._db.collection("users");
    // No createIndex — Atlas free tier restricts it.
    // Uniqueness is enforced by always filtering on userId as the upsert key.
  }

  async getUser(userId) {
    const result = await this._users.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          balance: 1000,
          totalWon: 0,
          totalLost: 0,
          gamesPlayed: 0,
        },
      },
      { upsert: true, returnDocument: "after" }
    );
    return result.value ?? result;
  }

  async updateBalance(userId, delta) {
    const result = await this._users.findOneAndUpdate(
      { userId },
      { $inc: { balance: delta } },
      { upsert: true, returnDocument: "after" }
    );
    return result.value ?? result;
  }

  async recordGame(userId, won, amount) {
    await this._users.updateOne(
      { userId },
      {
        $inc: {
          gamesPlayed: 1,
          totalWon: won ? amount : 0,
          totalLost: won ? 0 : amount,
        },
      },
      { upsert: true }
    );
  }

  async transfer(fromId, toId, amount) {
    const from = await this.getUser(fromId);
    if ((from.balance ?? 0) < amount) return false;
    await this._users.updateOne({ userId: fromId }, { $inc: { balance: -amount } }, { upsert: true });
    await this._users.updateOne({ userId: toId },   { $inc: { balance:  amount } }, { upsert: true });
    return true;
  }

  async getLeaderboard(field = "balance", limit = 10) {
    return this._users
      .find({})
      .sort({ [field]: -1 })
      .limit(limit)
      .toArray();
  }
}
