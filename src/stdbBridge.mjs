// StdbBridge — the Node bot's link to SpacetimeDB. The Bun web service owns the
// single STDB connection; the bot calls its localhost /internal/* endpoints
// (shared-secret) for balance ops instead of running the STDB TS SDK under Node.
//
// Attached to Database via db.attachBalanceBridge(); when present, all balance
// reads/writes delegate to STDB and Mongo keeps only profile/stats.

export class StdbBridge {
  constructor(baseUrl, secret) {
    this.base = String(baseUrl || "").replace(/\/$/, "");
    this.secret = secret || "";
  }
  async _post(path, body) {
    try {
      const r = await fetch(this.base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal": this.secret },
        body: JSON.stringify(body),
      });
      return r.ok ? await r.json() : { ok: false, error: "http " + r.status };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async _get(path) {
    try {
      const r = await fetch(this.base + path, { headers: { "x-internal": this.secret } });
      return r.ok ? await r.json() : {};
    } catch { return {}; }
  }
  async balance(uid)                      { const d = await this._get("/internal/balance/" + encodeURIComponent(uid)); return Number(d.bal || 0); }
  async credit(uid, amount)               { return this._post("/internal/credit", { uid, amount }); }
  async deduct(uid, amount)               { return this._post("/internal/deduct", { uid, amount }); }
  async settle(uid, bet, payout)          { return this._post("/internal/settle", { uid, bet, payout }); }
  async transfer(from, to, amount, fromTag){ return this._post("/internal/transfer", { from, to, amount, fromTag }); }
  async notify(uid, kind, amount, fromTag, msg) { return this._post("/internal/notify", { uid, kind, amount, fromTag, msg }); }
  async setExact(uid, balance)            { return this._post("/internal/set", { uid, balance }); }
  async guildUpdate(gid, data)            { return this._post("/internal/guild", { gid, ...data }); } // realtime name/icon push
}
