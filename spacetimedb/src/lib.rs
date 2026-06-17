//! SirGreen Casino — SpacetimeDB transaction module (`sirgreen-6ls47`).
//!
//! SpacetimeDB owns BALANCES + TRANSACTIONS + NOTIFICATIONS. Every reducer runs
//! inside an ACID transaction, so deduct/credit/transfer/settle are atomic and
//! race-free without app-level locks — and far faster than Mongo round-trips.
//!
//! MongoDB still stores everything else (user profiles, sessions, cases, stats).
//!
//! Clients (the Bun web service + the Node bot) call these reducers and SUBSCRIBE
//! to the `account` and `notification` tables for realtime balance/notification
//! pushes over the SpacetimeDB websocket — no polling.

use spacetimedb::{reducer, table, ReducerContext, Table};

/// Hard ceiling so a bug can never mint absurd balances.
const MAX_BALANCE: i64 = 1_000_000_000_000; // 1e12 FC
const MAX_DELTA: i64 = 1_000_000_000;       // 1e9 FC per single op
const MAX_NOTIFS: usize = 50;               // keep only the newest N per user

// ─── Tables ──────────────────────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────

fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch() / 1000
}

fn clamp_balance(v: i64) -> i64 {
    if v < 0 { 0 } else if v > MAX_BALANCE { MAX_BALANCE } else { v }
}

/// Fetch an account, creating it at 0 if missing. Returns the current balance.
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
    // Trim oldest beyond the cap (ids are monotonic, so smallest id == oldest).
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

// ─── Reducers (each is an atomic transaction) ────────────────────────────────

/// Make sure an account row exists (called on login / first touch).
#[reducer]
pub fn ensure_account(ctx: &ReducerContext, owner: String) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    ensure(ctx, &owner);
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
/// Used by stateless games (slots) where the round is computed server-side.
#[reducer]
pub fn settle(ctx: &ReducerContext, owner: String, bet: i64, payout: i64) -> Result<(), String> {
    if owner.is_empty() { return Err("empty owner".into()); }
    if bet < 0 || bet > MAX_DELTA || payout < 0 || payout > MAX_DELTA { return Err("bad amount".into()); }
    let a = ensure(ctx, &owner);
    if a.balance < bet { return Err("insufficient".into()); }
    set_balance(ctx, &owner, a.balance - bet + payout);
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
