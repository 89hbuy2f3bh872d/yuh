# fluxer-casino-bot

A virtual-currency gambling bot for Fluxer with MongoDB-backed global balances.

## Commands

| Command | Description |
|---|---|
| `!balance` | Check your Flux balance |
| `!daily` | Claim daily 500 Flux |
| `!pay @user <amount>` | Send Flux (supports `all`, `half`, `1k`, `2.5m`) |
| `!leaderboard [rich\|winners]` | Global leaderboard |
| `!slots <bet>` | Slot machine (max 1,000,000) |
| `!coinflip <heads\|tails> <bet>` | Coin flip (max 500,000) |
| `!dice <bet>` | Dice vs house (max 250,000) |
| `!roulette <pick> <bet>` | European roulette (max 750,000) |
| `!blackjack <bet>` | Full blackjack with hit/stand/double |
| `!crash <bet> <cashout>` | Crash game (max 2,000,000) |

## Setup

```bash
git clone https://github.com/vermingov/fluxer-casino-bot
cd fluxer-casino-bot && npm install
cp config_example.json config.json   # fill in token + mongodb.uri
npm start
# or:
docker compose up -d
```

## House Edge

| Game | RTP | Edge |
|------|-----|------|
| Slots | 92% | 8% |
| Coinflip | 95% | 5% |
| Dice | ~94% | ~6% |
| Roulette | ~97.3% | ~2.7% |
| Blackjack | ~99% | ~1% |
| Crash | 93% | 7% |
