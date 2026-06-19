//! SirGreen Casino — SpacetimeDB transaction module (`sirgreen-6ls47`).
//!
//! SpacetimeDB now owns the **entire datastore** (migrated off MongoDB). Every reducer
//! runs inside an ACID transaction, so all mutations are atomic and race-free without
//! app-level locks — and far faster than the old Mongo round-trips.
//!
//! Ownership map (was Mongo → now STDB tables):
//!   • account / server_bank / notification — balances, banks, inbox (original ledger)
//!   • user_profile  — profile + stats + perms + guild ids + pet (Mongo `u`)
//!   • session       — web session tokens (Mongo `u.st`)
//!   • guild         — per-server config: tax, rakeback, shop, role shop, verify (Mongo `guilds`)
//!   • server_stats / server_player — per-server economy stats + unique players (Mongo `serverstats`)
//!   • holding       — investing positions, relational (Mongo `holdings.h`)
//!   • invest_asset  — investing assets + price history (Mongo `assets`)
//!   • ticket        — support tickets (Mongo `tickets`)
//!   • rakeback_ledger — per-user-per-server rakeback (Mongo `rakeback`)
//!   • login_token   — one-time &web login links (Mongo `logintokens`)
//!   • stat_counter / daily_stat — command counters (Mongo `stats`)
//!   • kv            — misc singletons (e.g. custom case tiers; Mongo `cb_tiers`)
//!
//! JSON-shaped fields (perms, gids, shop, role_shop, ticket messages, asset hist, pet)
//! are stored as OPAQUE `String` blobs — the web layer parses/merges them. Only numeric
//! money/stat changes live as i64/f64 math in the reducers (where atomicity matters).
//!
//! Clients (the Bun web service) call these reducers and SUBSCRIBE to the tables for
//! realtime pushes over the SpacetimeDB websocket. The Node bot reaches STDB indirectly
//! via the web service's loopback `/internal/*` endpoints (it runs no STDB client).

use spacetimedb::{reducer, table, ReducerContext, Table};

/// Hard ceiling so a bug can never mint absurd balances.
const MAX_BALANCE: i64 = 1_000_000_000_000; // 1e12 FC
const MAX_DELTA: i64 = 1_000_000_000;       // 1e9 FC per single op
const MAX_NOTIFS: usize = 50;               // keep only the newest N per user
const STARTER_BALANCE: i64 = 1000;          // granted once, on first login (ensure_account)
const MAX_STAT: i64 = 1_000_000_000_000_000; // 1e15 — saturating ceiling for stat counters
const DEFAULT_TAX_BPS: i64 = 1500;          // 15% default per-server tax
const DEFAULT_RAKEBACK_PCT: i64 = 5;        // 5% default rakeback

// ─── Tables (original ledger — unchanged) ───────────────────────────────────

/// One row per user. `owner` is the Discord/Fluxer user id (string).
#[table(name = account, public)]
pub struct Account {
    #[primary_key]
    owner: String,
    balance: i64,
}

/// Per-user notification inbox. Indexed by owner for fast per-user queries.
#[table(name = notification, public, index(name = by_owner, btree(columns = [owner])))]
pub struct Notification {
    #[primary_key]
    #[auto_inc]
    id: u64,
    owner: String,
    kind: String,     // "pay" | "info" | ...
    amount: i64,      // 0 when not money-related
    from_tag: String, // sender display name (for "pay")
    msg: String,
    ts: i64,          // unix millis
    read: bool,
}

/// Per-server bank — accrues the tax taken from players' winnings on that server.
#[table(name = server_bank, public)]
pub struct ServerBank {
    #[primary_key]
    gid: String,      // guild id
    balance: i64,
}

// ─── Tables (migrated from MongoDB) ─────────────────────────────────────────

/// User profile + lifetime stats + admin perms + guild membership + pet.
/// Balances live in `account` (NOT here) — this is everything else off Mongo `u`.
#[table(name = user_profile, public)]
pub struct UserProfile {
    #[primary_key]
    owner: String,
    tag: String,       // Fluxer display name (cached at login)
    av: String,        // avatar url
    tw: i64,           // total won
    tl: i64,           // total lost
    gp: i64,           // games played
    ld: i64,           // last daily (ms)
    lw: i64,           // last work (ms)
    bwd_day: String,   // bank-withdraw ledger: UTC day string
    bwd_total: i64,    // bank-withdraw ledger: total withdrawn that day
    perms: String,     // JSON array of admin permission strings
    gids: String,      // JSON array of guild ids the user belongs to
    pet: String,       // JSON pet doc (or empty)
}

/// Web session tokens. PK is the token; indexed by owner for revoke-all / listing.
#[table(name = session, public, index(name = by_owner, btree(columns = [owner])))]
pub struct Session {
    #[primary_key]
    token: String,
    owner: String,
    expiry_ms: i64,
}

/// Per-server (guild) configuration + economy knobs.
#[table(name = guild, public)]
pub struct Guild {
    #[primary_key]
    gid: String,
    owner_id: String,
    name: String,
    icon: String,
    member_count: i64,
    invite: String,
    tax_bps: i64,
    rakeback_pct: i64,
    verified: bool,
    shop: String,      // JSON sub-doc
    role_shop: String, // JSON array
    last_seen: i64,
    joined_at: i64,
}

/// Per-server economy stats (owner dashboard). `player_count` replaces the old
/// unbounded `players[]` set — uniqueness tracked relationally in `server_player`.
#[table(name = server_stats, public)]
pub struct ServerStats {
    #[primary_key]
    gid: String,
    gp: i64,
    wagered: i64,
    payout: i64,
    taxed: i64,
    big: i64,
    player_count: i64,
    last_play: i64,
}

/// One row per (guild, user) who has ever wagered there — drives `player_count`
/// without an unbounded array. PK is "gid|uid".
#[table(name = server_player, public, index(name = by_gid, btree(columns = [gid])))]
pub struct ServerPlayer {
    #[primary_key]
    key: String, // gid|uid
    gid: String,
    uid: String,
}

/// Investing position. Relational (one row per owner+asset) — fixes the old
/// aggregation pipeline over a nested sub-doc. PK is "owner|asset_id".
#[table(name = holding, public, index(name = by_owner, btree(columns = [owner])), index(name = by_asset, btree(columns = [asset_id])))]
pub struct Holding {
    #[primary_key]
    key: String, // owner|asset_id
    owner: String,
    asset_id: String,
    units: f64,
    cost: i64, // cost basis (FC)
}

/// Investing asset + price state + history. The web price engine is the single writer.
#[table(name = invest_asset, public)]
pub struct InvestAsset {
    #[primary_key]
    id: String,
    kind: String,
    name: String,
    emoji: String,
    color: String,
    price: f64,
    baseline: f64,
    vol: f64,
    supply: f64,
    prev_price: f64,
    bias: f64,
    hist: String, // JSON array of [ts, price]
    updated_at: i64,
}

/// Support ticket. PK is a web-generated id string (so the web knows it up front).
#[table(name = ticket, public, index(name = by_uid, btree(columns = [uid])))]
pub struct Ticket {
    #[primary_key]
    id: String,
    uid: String,
    tag: String,
    subject: String,
    status: String,
    messages: String, // JSON array
    updated_at: i64,
    created_at: i64,
}

/// Per-user-per-server rakeback ledger. PK is "uid@gid".
#[table(name = rakeback_ledger, public, index(name = by_uid, btree(columns = [uid])))]
pub struct RakebackLedger {
    #[primary_key]
    key: String, // uid@gid
    uid: String,
    gid: String,
    accrued: i64,
    wagered: i64,
    claimed: i64,
    updated_at: i64,
}

/// One-time server-scoped login token (minted by &web, consumed by /s/:token).
#[table(name = login_token, public)]
pub struct LoginToken {
    #[primary_key]
    token: String,
    uid: String,
    gid: String,
    exp_at: i64,
}

/// All-time per-command counter. PK is the command name.
#[table(name = stat_counter, public)]
pub struct StatCounter {
    #[primary_key]
    key: String,
    count: i64,
}

/// Daily command totals (one row per YYYY-MM-DD). `cmds` kept for shape parity but
/// not maintained per-command (nothing reads it; all-time per-cmd lives in stat_counter).
#[table(name = daily_stat, public)]
pub struct DailyStat {
    #[primary_key]
    date: String,
    total: i64,
    cmds: String,
}

/// Generic key→value singleton store (custom case tiers, misc config blobs).
#[table(name = kv, public)]
pub struct Kv {
    #[primary_key]
    key: String,
    val: String,
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch() / 1000
}

fn clamp_balance(v: i64) -> i64 {
    if v < 0 { 0 } else if v > MAX_BALANCE { MAX_BALANCE } else { v }
}

/// Saturating, non-negative add for stat counters (never panics on overflow).
fn add_stat(cur: i64, delta: i64) -> i64 {
    let v = cur.saturating_add(delta);
    if v < 0 { 0 } else if v > MAX_STAT { MAX_STAT } else { v }
}

/// Fetch an account, creating it at 0 if missing. Returns the current row.
fn ensure(ctx: &ReducerContext, owner: &str) -> Account {
    if let Some(a) = ctx.db.account().owner().find(owner.to_string()) {
        a
    } else {
        ctx.db.account().insert(Account { owner: owner.to_string(), balance: 0 })
    }
}

fn set_balance(ctx: &ReducerContext, owner: &str, balance: i64) {
    let a = ensure(ctx, owner);
    ctx.db.account().owner().update(Account { owner: a.owner, balance: clamp_balance(balance) });
}

fn bank_add(ctx: &ReducerContext, gid: &str, amt: i64) {
    if gid.is_empty() || amt <= 0 { return; }
    if let Some(b) = ctx.db.server_bank().gid().find(gid.to_string()) {
        ctx.db.server_bank().gid().update(ServerBank { gid: b.gid, balance: clamp_balance(b.balance + amt) });
    } else {
        ctx.db.server_bank().insert(ServerBank { gid: gid.to_string(), balance: clamp_balance(amt) });
    }
}

/// Append a notification and trim to the newest MAX_NOTIFS for that user.
fn push_notification(ctx: &ReducerContext, owner: &str, kind: &str, amount: i64, from_tag: &str, msg: &str) {
    ctx.db.notification().insert(Notification {
        id: 0, // auto_inc
        owner: owner.to_string(),
        kind: kind.to_string(),
        amount,
        from_tag: from_tag.to_string(),
        msg: msg.to_string(),
        ts: now_ms(ctx),
        read: false,
    });
    let key = owner.to_string();
    let mut rows: Vec<Notification> = ctx.db.notification().by_owner().filter(&key).collect();
    if rows.len() > MAX_NOTIFS {
        rows.sort_by_key(|n| n.id);
        let remove = rows.len() - MAX_NOTIFS;
        for n in rows.into_iter().take(remove) {
            ctx.db.notification().id().delete(n.id);
        }
    }
}

/// Fetch a profile, creating an empty one if missing.
fn ensure_profile(ctx: &ReducerContext, owner: &str) -> UserProfile {
    if let Some(p) = ctx.db.user_profile().owner().find(owner.to_string()) {
        p
    } else {
        ctx.db.user_profile().insert(UserProfile {
            owner: owner.to_string(),
            tag: String::new(), av: String::new(),
            tw: 0, tl: 0, gp: 0, ld: 0, lw: 0,
            bwd_day: String::new(), bwd_total: 0,
            perms: String::new(), gids: String::new(), pet: String::new(),
        })
    }
}

/// Fetch a guild config, creating it with defaults if missing.
fn ensure_guild(ctx: &ReducerContext, gid: &str) -> Guild {
    if let Some(g) = ctx.db.guild().gid().find(gid.to_string()) {
        g
    } else {
        let now = now_ms(ctx);
        ctx.db.guild().insert(Guild {
            gid: gid.to_string(),
            owner_id: String::new(), name: String::new(), icon: String::new(),
            member_count: 0, invite: String::new(),
            tax_bps: DEFAULT_TAX_BPS, rakeback_pct: DEFAULT_RAKEBACK_PCT, verified: false,
            shop: String::new(), role_shop: String::new(),
            last_seen: now, joined_at: now,
        })
    }
}

/// Fetch a server-stats row, creating a zeroed one if missing.
fn ensure_stats(ctx: &ReducerContext, gid: &str) -> ServerStats {
    if let Some(s) = ctx.db.server_stats().gid().find(gid.to_string()) {
        s
    } else {
        ctx.db.server_stats().insert(ServerStats {
            gid: gid.to_string(),
            gp: 0, wagered: 0, payout: 0, taxed: 0, big: 0, player_count: 0, last_play: 0,
        })
    }
}

// ─── Reducers: original ledger (unchanged) ───────────────────────────────────

/// Make sure an account row exists (called on login / first touch).
#[reducer]
pub fn ensure_account(ctx: &ReducerContext, owner: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    // First touch (login) → seed the starter balance once. Internal ensure() stays 0,
    // so deduct/credit on a missing account can never mint the starter amount.
    if ctx.db.account().owner().find(owner.clone()).is_none() {
        ctx.db.account().insert(Account { owner, balance: STARTER_BALANCE });
    }
    Ok(())
}

/// Add funds (daily, work, admin grant, game payout).
#[reducer]
pub fn credit(ctx: &ReducerContext, owner: String, amount: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if amount <= 0 || amount > MAX_DELTA { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    set_balance(ctx, &owner, a.balance + amount);
    Ok(())
}

/// Remove funds (place a bet, buy). Fails (aborts the txn) if balance is too low.
#[reducer]
pub fn deduct(ctx: &ReducerContext, owner: String, amount: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if amount <= 0 || amount > MAX_DELTA { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    if a.balance < amount { return Err("insufficient".into()); }
    set_balance(ctx, &owner, a.balance - amount);
    Ok(())
}

/// Resolve a whole game round atomically: take `bet`, pay `payout`.
#[reducer]
pub fn settle(ctx: &ReducerContext, owner: String, bet: i64, payout: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if bet < 0 || bet > MAX_DELTA || payout < 0 || payout > MAX_DELTA { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    if a.balance < bet { return Err("insufficient".into()); }
    set_balance(ctx, &owner, a.balance - bet + payout);
    Ok(())
}

/// Atomic round WITH a server tax: take bet, pay (payout - tax) to the player, route
/// `tax` to the server's bank. Aborts if the player can't cover the bet.
#[reducer]
pub fn settle_win(ctx: &ReducerContext, owner: String, bet: i64, payout: i64, gid: String, tax: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if bet < 0 || bet > MAX_DELTA || payout < 0 || payout > MAX_DELTA || tax < 0 || tax > payout { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    if a.balance < bet { return Err("insufficient".into()); }
    set_balance(ctx, &owner, a.balance - bet + (payout - tax));
    bank_add(ctx, &gid, tax);
    Ok(())
}

/// Credit a win already staked elsewhere (house cashout / case battle), minus tax.
#[reducer]
pub fn credit_win(ctx: &ReducerContext, owner: String, gross: i64, gid: String, tax: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if gross < 0 || gross > MAX_DELTA || tax < 0 || tax > gross { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    set_balance(ctx, &owner, a.balance + (gross - tax));
    bank_add(ctx, &gid, tax);
    Ok(())
}

/// Spend from a server bank (shop). Aborts if the bank can't cover it.
#[reducer]
pub fn bank_spend(ctx: &ReducerContext, gid: String, amount: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    if amount <= 0 || amount > MAX_DELTA { return Err("bad amount".into()); }
    let b = ctx.db.server_bank().gid().find(gid.clone()).ok_or_else(|| "no bank".to_string())?;
    if b.balance < amount { return Err("insufficient".into()); }
    ctx.db.server_bank().gid().update(ServerBank { gid: b.gid, balance: b.balance - amount });
    Ok(())
}

/// Set a server bank to an exact balance (admin tool). Creates the row if missing.
#[reducer]
pub fn bank_set(ctx: &ReducerContext, gid: String, balance: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    if balance < 0 || balance > MAX_BALANCE { return Err("bad amount".into()); }
    if let Some(b) = ctx.db.server_bank().gid().find(gid.clone()) {
        ctx.db.server_bank().gid().update(ServerBank { gid: b.gid, balance });
    } else {
        ctx.db.server_bank().insert(ServerBank { gid, balance });
    }
    Ok(())
}

/// Atomic transfer between two users + a "pay" notification to the receiver.
#[reducer]
pub fn transfer(ctx: &ReducerContext, from: String, to: String, amount: i64, from_tag: String) -> Result<(), String> {
    if from.is_empty() || to.is_empty() { return Err("empty owner".into()); }
    if from == to { return Err("same account".into()); }
    if amount <= 0 || amount > MAX_DELTA { return Err("bad amount".into()); }
    let sender = ensure(ctx, &from);
    if sender.balance < amount { return Err("insufficient".into()); }
    let receiver = ensure(ctx, &to);
    set_balance(ctx, &from, sender.balance - amount);
    set_balance(ctx, &to, receiver.balance + amount);
    let tag = if from_tag.is_empty() { from.clone() } else { from_tag };
    push_notification(ctx, &to, "pay", amount, &tag, &format!("received {} FC", amount));
    Ok(())
}

/// Owner-only / system: set an exact balance (admin balance edit, fresh seed).
#[reducer]
pub fn set_exact(ctx: &ReducerContext, owner: String, balance: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if balance < 0 || balance > MAX_BALANCE { return Err("bad balance".into()); }
    set_balance(ctx, &owner, balance);
    Ok(())
}

/// Send an arbitrary notification (system messages, bonuses, etc).
#[reducer]
pub fn add_notification(ctx: &ReducerContext, owner: String, kind: String, amount: i64, from_tag: String, msg: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    push_notification(ctx, &owner, &kind, amount, &from_tag, &msg);
    Ok(())
}

/// Mark all of a user's notifications read (called when they open the tab).
#[reducer]
pub fn mark_read(ctx: &ReducerContext, owner: String) -> Result<(), String> {
    let rows: Vec<Notification> = ctx.db.notification().by_owner().filter(&owner).collect();
    for n in rows {
        if !n.read {
            ctx.db.notification().id().update(Notification { read: true, ..n });
        }
    }
    Ok(())
}

// ─── Reducers: user profile + stats ─────────────────────────────────────────

/// Cache a user's display tag + avatar (called on every OAuth login). Creates the
/// profile if missing; only overwrites tag/av when a non-empty value is supplied.
#[reducer]
pub fn upsert_profile(ctx: &ReducerContext, owner: String, tag: String, av: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    if !tag.is_empty() { p.tag = tag.chars().take(64).collect(); }
    if !av.is_empty() { p.av = av.chars().take(256).collect(); }
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

/// Record a game result: +1 games, and += amount to won or lost.
#[reducer]
pub fn record_game_stats(ctx: &ReducerContext, owner: String, won: bool, amount: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let amt = if amount < 0 { 0 } else { amount };
    let mut p = ensure_profile(ctx, &owner);
    p.gp = add_stat(p.gp, 1);
    if won { p.tw = add_stat(p.tw, amt); } else { p.tl = add_stat(p.tl, amt); }
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

/// Overwrite the admin permission array (stored as opaque JSON).
#[reducer]
pub fn set_perms(ctx: &ReducerContext, owner: String, perms_json: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    p.perms = perms_json;
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

/// Overwrite the user's guild-id list (opaque JSON). The web merges/appends in JS.
#[reducer]
pub fn set_user_guilds(ctx: &ReducerContext, owner: String, gids_json: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    p.gids = gids_json;
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

/// Set (or clear, via empty string) the user's pet (opaque JSON).
#[reducer]
pub fn set_pet(ctx: &ReducerContext, owner: String, pet_json: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    p.pet = pet_json;
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

#[reducer]
pub fn set_last_daily(ctx: &ReducerContext, owner: String, ts: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    p.ld = if ts < 0 { 0 } else { ts };
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

#[reducer]
pub fn set_last_work(ctx: &ReducerContext, owner: String, ts: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let mut p = ensure_profile(ctx, &owner);
    p.lw = if ts < 0 { 0 } else { ts };
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

/// Atomic bank-withdraw ledger increment against a daily cap. Aborts if it would
/// exceed `cap` — race-free because the read+check+write is one transaction.
#[reducer]
pub fn try_bank_withdraw(ctx: &ReducerContext, owner: String, day: String, amount: i64, cap: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if amount <= 0 || amount > MAX_DELTA { return Err("bad amount".into()); }
    let mut p = ensure_profile(ctx, &owner);
    let cur = if p.bwd_day == day { p.bwd_total } else { 0 };
    if cur + amount > cap { return Err("cap exceeded".into()); }
    p.bwd_day = day;
    p.bwd_total = cur + amount;
    ctx.db.user_profile().owner().update(p);
    Ok(())
}

// ─── Reducers: sessions ─────────────────────────────────────────────────────

#[reducer]
pub fn create_session(ctx: &ReducerContext, owner: String, token: String, expiry_ms: i64) -> Result<(), String> {
    if owner.is_empty() || token.is_empty() { return Err("empty".into()); }
    if let Some(s) = ctx.db.session().token().find(token.clone()) {
        ctx.db.session().token().update(Session { token: s.token, owner, expiry_ms });
    } else {
        ctx.db.session().insert(Session { token, owner, expiry_ms });
    }
    Ok(())
}

#[reducer]
pub fn revoke_session(ctx: &ReducerContext, token: String) -> Result<(), String> {
    if token.is_empty() { return Ok(()); }
    ctx.db.session().token().delete(token);
    Ok(())
}

#[reducer]
pub fn revoke_all_sessions(ctx: &ReducerContext, owner: String) -> Result<(), String> {
    if owner.is_empty() { return Ok(()); }
    let toks: Vec<String> = ctx.db.session().by_owner().filter(&owner).map(|s| s.token).collect();
    for t in toks { ctx.db.session().token().delete(t); }
    Ok(())
}

#[reducer]
pub fn prune_expired_sessions(ctx: &ReducerContext) -> Result<(), String> {
    let now = now_ms(ctx);
    let toks: Vec<String> = ctx.db.session().iter().filter(|s| s.expiry_ms < now).map(|s| s.token).collect();
    for t in toks { ctx.db.session().token().delete(t); }
    Ok(())
}

// ─── Reducers: guilds ───────────────────────────────────────────────────────

/// Upsert basic guild fields seen from a message (name/icon/owner/members).
#[reducer]
pub fn upsert_guild(ctx: &ReducerContext, gid: String, owner_id: String, name: String, icon: String, member_count: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let mut g = ensure_guild(ctx, &gid);
    if !owner_id.is_empty() { g.owner_id = owner_id; }
    if !name.is_empty() { g.name = name.chars().take(128).collect(); }
    if !icon.is_empty() { g.icon = icon.chars().take(256).collect(); }
    if member_count > 0 { g.member_count = member_count; }
    g.last_seen = now_ms(ctx);
    ctx.db.guild().gid().update(g);
    Ok(())
}

#[reducer]
pub fn set_guild_tax(ctx: &ReducerContext, gid: String, tax_bps: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let v = if tax_bps < 0 { 0 } else if tax_bps > 5000 { 5000 } else { tax_bps };
    let mut g = ensure_guild(ctx, &gid);
    g.tax_bps = v; g.last_seen = now_ms(ctx);
    ctx.db.guild().gid().update(g);
    Ok(())
}

#[reducer]
pub fn set_guild_rakeback(ctx: &ReducerContext, gid: String, pct: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let v = if pct < 0 { 0 } else if pct > 20 { 20 } else { pct };
    let mut g = ensure_guild(ctx, &gid);
    g.rakeback_pct = v; g.last_seen = now_ms(ctx);
    ctx.db.guild().gid().update(g);
    Ok(())
}

#[reducer]
pub fn set_guild_verified(ctx: &ReducerContext, gid: String, verified: bool) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let mut g = ensure_guild(ctx, &gid);
    g.verified = verified;
    ctx.db.guild().gid().update(g);
    Ok(())
}

#[reducer]
pub fn set_guild_invite(ctx: &ReducerContext, gid: String, invite: String) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let mut g = ensure_guild(ctx, &gid);
    g.invite = invite.chars().take(256).collect();
    ctx.db.guild().gid().update(g);
    Ok(())
}

/// Set the guild shop sub-doc (opaque JSON; the web merges before calling).
#[reducer]
pub fn set_guild_shop(ctx: &ReducerContext, gid: String, shop_json: String) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let mut g = ensure_guild(ctx, &gid);
    g.shop = shop_json; g.last_seen = now_ms(ctx);
    ctx.db.guild().gid().update(g);
    Ok(())
}

/// Set the guild role shop (opaque JSON array).
#[reducer]
pub fn set_role_shop(ctx: &ReducerContext, gid: String, role_shop_json: String) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let mut g = ensure_guild(ctx, &gid);
    g.role_shop = role_shop_json;
    ctx.db.guild().gid().update(g);
    Ok(())
}

// ─── Reducers: server stats ─────────────────────────────────────────────────

/// Count a wager on a server. Increments gp+wagered, stamps last_play, and bumps
/// player_count the first time this uid plays here (tracked in server_player).
#[reducer]
pub fn record_server_wager(ctx: &ReducerContext, gid: String, uid: String, amount: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let amt = if amount < 0 { 0 } else { amount };
    let mut s = ensure_stats(ctx, &gid);
    s.gp = add_stat(s.gp, 1);
    s.wagered = add_stat(s.wagered, amt);
    s.last_play = now_ms(ctx);
    if !uid.is_empty() {
        let key = format!("{}|{}", gid, uid);
        if ctx.db.server_player().key().find(key.clone()).is_none() {
            ctx.db.server_player().insert(ServerPlayer { key, gid: gid.clone(), uid });
            s.player_count = add_stat(s.player_count, 1);
        }
    }
    ctx.db.server_stats().gid().update(s);
    Ok(())
}

/// Record a payout + the tax it fed into the bank. Tracks the biggest single payout.
#[reducer]
pub fn record_server_payout(ctx: &ReducerContext, gid: String, payout: i64, tax: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let pay = if payout < 0 { 0 } else { payout };
    let tx = if tax < 0 { 0 } else { tax };
    let mut s = ensure_stats(ctx, &gid);
    s.payout = add_stat(s.payout, pay);
    s.taxed = add_stat(s.taxed, tx);
    if pay > s.big { s.big = pay; }
    ctx.db.server_stats().gid().update(s);
    Ok(())
}

// ─── Reducers: investing holdings ───────────────────────────────────────────

/// Add units + cost to a position (buy). Upserts the (owner, asset) row.
#[reducer]
pub fn add_holding(ctx: &ReducerContext, owner: String, asset_id: String, units: f64, cost: i64) -> Result<(), String> {
    if owner.is_empty() || asset_id.is_empty() { return Err("empty".into()); }
    if !(units > 0.0) || cost < 0 { return Err("bad amount".into()); }
    let key = format!("{}|{}", owner, asset_id);
    if let Some(h) = ctx.db.holding().key().find(key.clone()) {
        ctx.db.holding().key().update(Holding { units: h.units + units, cost: add_stat(h.cost, cost), ..h });
    } else {
        ctx.db.holding().insert(Holding { key, owner, asset_id, units, cost });
    }
    Ok(())
}

/// Sell `sell_units` from a position, reducing cost basis by `cost_portion` (computed
/// by the web from the pre-trade row). Aborts if the position lacks the units, so two
/// concurrent sells can't both pass the guard. Deletes the row when it empties.
#[reducer]
pub fn remove_holding(ctx: &ReducerContext, owner: String, asset_id: String, sell_units: f64, cost_portion: i64) -> Result<(), String> {
    if owner.is_empty() || asset_id.is_empty() { return Err("empty".into()); }
    if !(sell_units > 0.0) { return Err("bad amount".into()); }
    let key = format!("{}|{}", owner, asset_id);
    let h = ctx.db.holding().key().find(key.clone()).ok_or_else(|| "no position".to_string())?;
    if h.units + 1e-9 < sell_units { return Err("insufficient".into()); }
    let new_units = h.units - sell_units;
    let new_cost = if h.cost - cost_portion < 0 { 0 } else { h.cost - cost_portion };
    if new_units <= 1e-6 {
        ctx.db.holding().key().delete(key);
    } else {
        ctx.db.holding().key().update(Holding { units: new_units, cost: new_cost, ..h });
    }
    Ok(())
}

// ─── Reducers: rakeback ─────────────────────────────────────────────────────

/// Accrue rakeback (the web computes `earn` from wager×taxBps×pct). Upserts the ledger.
#[reducer]
pub fn add_rakeback(ctx: &ReducerContext, uid: String, gid: String, earn: i64, wager: i64) -> Result<(), String> {
    if uid.is_empty() || gid.is_empty() { return Err("empty".into()); }
    if earn <= 0 { return Ok(()); }
    let key = format!("{}@{}", uid, gid);
    let now = now_ms(ctx);
    let w = if wager < 0 { 0 } else { wager };
    if let Some(r) = ctx.db.rakeback_ledger().key().find(key.clone()) {
        ctx.db.rakeback_ledger().key().update(RakebackLedger {
            accrued: add_stat(r.accrued, earn), wagered: add_stat(r.wagered, w), updated_at: now, ..r
        });
    } else {
        ctx.db.rakeback_ledger().insert(RakebackLedger {
            key, uid, gid, accrued: earn, wagered: w, claimed: 0, updated_at: now,
        });
    }
    Ok(())
}

/// Atomically claim pending rakeback: zero accrued, add to claimed, AND credit the
/// player's balance — all in one transaction, so no double-claim is possible. The web
/// reads the balance delta to learn the amount paid.
#[reducer]
pub fn claim_rakeback(ctx: &ReducerContext, uid: String, gid: String) -> Result<(), String> {
    if uid.is_empty() || gid.is_empty() { return Err("empty".into()); }
    let key = format!("{}@{}", uid, gid);
    let r = match ctx.db.rakeback_ledger().key().find(key.clone()) {
        Some(r) => r,
        None => return Ok(()),
    };
    let amt = r.accrued;
    if amt <= 0 { return Ok(()); }
    ctx.db.rakeback_ledger().key().update(RakebackLedger {
        accrued: 0, claimed: add_stat(r.claimed, amt), updated_at: now_ms(ctx), ..r
    });
    let a = ensure(ctx, &uid);
    set_balance(ctx, &uid, a.balance + amt);
    Ok(())
}

// ─── Reducers: investing assets ─────────────────────────────────────────────

/// Upsert a full asset row (the web price engine is the single writer).
#[reducer]
pub fn save_asset(ctx: &ReducerContext, id: String, kind: String, name: String, emoji: String, color: String, price: f64, baseline: f64, vol: f64, supply: f64, prev_price: f64, bias: f64, hist: String, updated_at: i64) -> Result<(), String> {
    if id.is_empty() { return Err("empty id".into()); }
    let row = InvestAsset { id: id.clone(), kind, name, emoji, color, price, baseline, vol, supply, prev_price, bias, hist, updated_at };
    if ctx.db.invest_asset().id().find(id).is_some() {
        ctx.db.invest_asset().id().update(row);
    } else {
        ctx.db.invest_asset().insert(row);
    }
    Ok(())
}

// ─── Reducers: tickets ──────────────────────────────────────────────────────

/// Create a support ticket. The web generates the id (so it knows it immediately).
#[reducer]
pub fn create_ticket(ctx: &ReducerContext, id: String, uid: String, tag: String, subject: String, messages_json: String, created_at: i64) -> Result<(), String> {
    if id.is_empty() || uid.is_empty() { return Err("empty".into()); }
    if ctx.db.ticket().id().find(id.clone()).is_some() { return Err("exists".into()); }
    ctx.db.ticket().insert(Ticket {
        id, uid, tag, subject, status: "open".into(), messages: messages_json,
        updated_at: created_at, created_at,
    });
    Ok(())
}

/// Replace a ticket's message array (the web appends then sets) + status/updated_at.
#[reducer]
pub fn add_ticket_message(ctx: &ReducerContext, id: String, messages_json: String, status: String, updated_at: i64) -> Result<(), String> {
    if id.is_empty() { return Err("empty id".into()); }
    let t = ctx.db.ticket().id().find(id).ok_or_else(|| "no ticket".to_string())?;
    ctx.db.ticket().id().update(Ticket { messages: messages_json, status, updated_at, ..t });
    Ok(())
}

#[reducer]
pub fn set_ticket_status(ctx: &ReducerContext, id: String, status: String, updated_at: i64) -> Result<(), String> {
    if id.is_empty() { return Err("empty id".into()); }
    let t = ctx.db.ticket().id().find(id).ok_or_else(|| "no ticket".to_string())?;
    ctx.db.ticket().id().update(Ticket { status, updated_at, ..t });
    Ok(())
}

#[reducer]
pub fn delete_ticket(ctx: &ReducerContext, id: String) -> Result<(), String> {
    if id.is_empty() { return Ok(()); }
    ctx.db.ticket().id().delete(id);
    Ok(())
}

// ─── Reducers: login tokens ─────────────────────────────────────────────────

#[reducer]
pub fn create_login_token(ctx: &ReducerContext, token: String, uid: String, gid: String, exp_at: i64) -> Result<(), String> {
    if token.is_empty() || uid.is_empty() { return Err("empty".into()); }
    if ctx.db.login_token().token().find(token.clone()).is_some() {
        ctx.db.login_token().token().update(LoginToken { token, uid, gid, exp_at });
    } else {
        ctx.db.login_token().insert(LoginToken { token, uid, gid, exp_at });
    }
    Ok(())
}

/// Consume (delete) a login token. The web reads the row from cache first for uid/gid.
#[reducer]
pub fn consume_login_token(ctx: &ReducerContext, token: String) -> Result<(), String> {
    if token.is_empty() { return Ok(()); }
    ctx.db.login_token().token().delete(token);
    Ok(())
}

// ─── Reducers: command stats ────────────────────────────────────────────────

#[reducer]
pub fn record_command(ctx: &ReducerContext, name: String, date: String) -> Result<(), String> {
    if name.is_empty() { return Ok(()); }
    // all-time per-command counter
    if let Some(c) = ctx.db.stat_counter().key().find(name.clone()) {
        ctx.db.stat_counter().key().update(StatCounter { count: add_stat(c.count, 1), ..c });
    } else {
        ctx.db.stat_counter().insert(StatCounter { key: name, count: 1 });
    }
    // daily total
    if !date.is_empty() {
        if let Some(d) = ctx.db.daily_stat().date().find(date.clone()) {
            ctx.db.daily_stat().date().update(DailyStat { total: add_stat(d.total, 1), ..d });
        } else {
            ctx.db.daily_stat().insert(DailyStat { date, total: 1, cmds: "{}".into() });
        }
    }
    Ok(())
}

// ─── Reducers: kv singletons ────────────────────────────────────────────────

#[reducer]
pub fn kv_set(ctx: &ReducerContext, key: String, val: String) -> Result<(), String> {
    if key.is_empty() { return Err("empty key".into()); }
    if let Some(r) = ctx.db.kv().key().find(key.clone()) {
        ctx.db.kv().key().update(Kv { val, ..r });
    } else {
        ctx.db.kv().insert(Kv { key, val });
    }
    Ok(())
}

// ─── Reducers: migration import (exact full-row upserts; one-time Mongo→STDB) ──
// These set EXACT values (not increments) so existing Mongo data carries over with
// the same counts/balances. Balances are NOT imported (the STDB ledger already owns
// them — Mongo's `bal` was a stale starter). Idempotent: re-running overwrites.

#[reducer]
pub fn import_profile(ctx: &ReducerContext, owner: String, tag: String, av: String, tw: i64, tl: i64, gp: i64, ld: i64, lw: i64, bwd_day: String, bwd_total: i64, perms: String, gids: String, pet: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    let key = owner.clone();
    let row = UserProfile { owner, tag, av, tw, tl, gp, ld, lw, bwd_day, bwd_total, perms, gids, pet };
    if ctx.db.user_profile().owner().find(key).is_some() { ctx.db.user_profile().owner().update(row); } else { ctx.db.user_profile().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_guild(ctx: &ReducerContext, gid: String, owner_id: String, name: String, icon: String, member_count: i64, invite: String, tax_bps: i64, rakeback_pct: i64, verified: bool, shop: String, role_shop: String, last_seen: i64, joined_at: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let key = gid.clone();
    let row = Guild { gid, owner_id, name, icon, member_count, invite, tax_bps, rakeback_pct, verified, shop, role_shop, last_seen, joined_at };
    if ctx.db.guild().gid().find(key).is_some() { ctx.db.guild().gid().update(row); } else { ctx.db.guild().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_server_stats(ctx: &ReducerContext, gid: String, gp: i64, wagered: i64, payout: i64, taxed: i64, big: i64, player_count: i64, last_play: i64) -> Result<(), String> {
    if gid.is_empty() { return Err("empty gid".into()); }
    let key = gid.clone();
    let row = ServerStats { gid, gp, wagered, payout, taxed, big, player_count, last_play };
    if ctx.db.server_stats().gid().find(key).is_some() { ctx.db.server_stats().gid().update(row); } else { ctx.db.server_stats().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_holding(ctx: &ReducerContext, owner: String, asset_id: String, units: f64, cost: i64) -> Result<(), String> {
    if owner.is_empty() || asset_id.is_empty() { return Err("empty".into()); }
    let key = format!("{}|{}", owner, asset_id);
    let row = Holding { key: key.clone(), owner, asset_id, units, cost };
    if ctx.db.holding().key().find(key).is_some() { ctx.db.holding().key().update(row); } else { ctx.db.holding().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_rakeback(ctx: &ReducerContext, uid: String, gid: String, accrued: i64, wagered: i64, claimed: i64) -> Result<(), String> {
    if uid.is_empty() || gid.is_empty() { return Err("empty".into()); }
    let key = format!("{}@{}", uid, gid);
    let row = RakebackLedger { key: key.clone(), uid, gid, accrued, wagered, claimed, updated_at: now_ms(ctx) };
    if ctx.db.rakeback_ledger().key().find(key).is_some() { ctx.db.rakeback_ledger().key().update(row); } else { ctx.db.rakeback_ledger().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_stat_counter(ctx: &ReducerContext, key: String, count: i64) -> Result<(), String> {
    if key.is_empty() { return Err("empty key".into()); }
    let k = key.clone();
    let row = StatCounter { key, count };
    if ctx.db.stat_counter().key().find(k).is_some() { ctx.db.stat_counter().key().update(row); } else { ctx.db.stat_counter().insert(row); }
    Ok(())
}

#[reducer]
pub fn import_daily_stat(ctx: &ReducerContext, date: String, total: i64) -> Result<(), String> {
    if date.is_empty() { return Err("empty date".into()); }
    let k = date.clone();
    let row = DailyStat { date, total, cmds: "{}".into() };
    if ctx.db.daily_stat().date().find(k).is_some() { ctx.db.daily_stat().date().update(row); } else { ctx.db.daily_stat().insert(row); }
    Ok(())
}

// ─── Reducers: admin wipe ───────────────────────────────────────────────────

/// Delete every row of one table (owner-gated at the web route). Unknown name → error.
#[reducer]
pub fn wipe_table(ctx: &ReducerContext, table_name: String) -> Result<(), String> {
    match table_name.as_str() {
        "account" => { let ks: Vec<String> = ctx.db.account().iter().map(|r| r.owner).collect(); for k in ks { ctx.db.account().owner().delete(k); } }
        "server_bank" => { let ks: Vec<String> = ctx.db.server_bank().iter().map(|r| r.gid).collect(); for k in ks { ctx.db.server_bank().gid().delete(k); } }
        "notification" => { let ks: Vec<u64> = ctx.db.notification().iter().map(|r| r.id).collect(); for k in ks { ctx.db.notification().id().delete(k); } }
        "user_profile" => { let ks: Vec<String> = ctx.db.user_profile().iter().map(|r| r.owner).collect(); for k in ks { ctx.db.user_profile().owner().delete(k); } }
        "session" => { let ks: Vec<String> = ctx.db.session().iter().map(|r| r.token).collect(); for k in ks { ctx.db.session().token().delete(k); } }
        "guild" => { let ks: Vec<String> = ctx.db.guild().iter().map(|r| r.gid).collect(); for k in ks { ctx.db.guild().gid().delete(k); } }
        "server_stats" => { let ks: Vec<String> = ctx.db.server_stats().iter().map(|r| r.gid).collect(); for k in ks { ctx.db.server_stats().gid().delete(k); } }
        "server_player" => { let ks: Vec<String> = ctx.db.server_player().iter().map(|r| r.key).collect(); for k in ks { ctx.db.server_player().key().delete(k); } }
        "holding" => { let ks: Vec<String> = ctx.db.holding().iter().map(|r| r.key).collect(); for k in ks { ctx.db.holding().key().delete(k); } }
        "invest_asset" => { let ks: Vec<String> = ctx.db.invest_asset().iter().map(|r| r.id).collect(); for k in ks { ctx.db.invest_asset().id().delete(k); } }
        "ticket" => { let ks: Vec<String> = ctx.db.ticket().iter().map(|r| r.id).collect(); for k in ks { ctx.db.ticket().id().delete(k); } }
        "rakeback_ledger" => { let ks: Vec<String> = ctx.db.rakeback_ledger().iter().map(|r| r.key).collect(); for k in ks { ctx.db.rakeback_ledger().key().delete(k); } }
        "login_token" => { let ks: Vec<String> = ctx.db.login_token().iter().map(|r| r.token).collect(); for k in ks { ctx.db.login_token().token().delete(k); } }
        "stat_counter" => { let ks: Vec<String> = ctx.db.stat_counter().iter().map(|r| r.key).collect(); for k in ks { ctx.db.stat_counter().key().delete(k); } }
        "daily_stat" => { let ks: Vec<String> = ctx.db.daily_stat().iter().map(|r| r.date).collect(); for k in ks { ctx.db.daily_stat().date().delete(k); } }
        "kv" => { let ks: Vec<String> = ctx.db.kv().iter().map(|r| r.key).collect(); for k in ks { ctx.db.kv().key().delete(k); } }
        _ => return Err("unknown table".into()),
    }
    Ok(())
}
