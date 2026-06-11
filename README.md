# 🎰 fluxer-casino

An advanced **Fluxer** virtual-currency casino bot with a global MongoDB-backed economy, house-edge games, psychological bait messages, and a cross-server leaderboard.

> Requires **Node.js ≥ 22.0.0** and a running **MongoDB** instance.

## Features

| Command | Description | House Edge |
|---|---|---|
| `!slots` | 3-reel slot machine with jackpots & near-miss engine | 8% |
| `!coinflip` | Heads or tails — 1.9x payout | 5% |
| `!dice` | Guess the roll (1–6) — 5.26x payout | 6% |
| `!roulette` | Full European wheel — straight, red/black, dozens, even/odd | 5.4% |
| `!blackjack` | Hit / Stand / Double — dealer soft-17, natural 2.4x | 4.5% |
| `!crash` | Ride the multiplier — optional auto-cashout | 7% |
| `!balance` | View your (or another user's) global balance | — |
| `!daily` | Claim 500–1000 Flux every 24 hours | — |
| `!pay` | Send Flux to another user (supports `all`/`half`/`1k`/`2.5m`) | — |
| `!leaderboard` | Global richest / top earners | — |

All balances are **global** — one wallet per user across every server.

## Setup

### 1. Clone & install

```bash
git clone https://github.com/vermingov/fluxer-casino-bot
cd fluxer-casino-bot
npm install
```

### 2. Configure

```bash
cp config_example.json config.json
```

Edit `config.json`:

```json
{
  "token": "your-fluxer-bot-token",
  "prefix": "!",
  "embedColor": "0xf5c518",
  "owners": ["your-user-id"],
  "mongodb": {
    "uri": "mongodb://localhost:27017",
    "database": "fluxer_casino"
  }
}
```

### 3. Run

```bash
npm start
```

### Docker (with MongoDB bundled)

```bash
docker compose up -d
```

MongoDB data is persisted in the `mongo_data` Docker volume.
