# 🎰 Fluxer Casino Bot

A gambling bot for [Fluxer](https://fluxer.app) with global balances, a web slot machine, leaderboards, and house-edge tuned games.

## Setup

### 1. Clone & install
```bash
git clone https://github.com/vermingov/fluxer-casino-bot
cd fluxer-casino-bot
npm install
```

### 2. Configure
```bash
cp config.example.json config.json
nano config.json
```

**Required fields:**

| Key | Where to find it |
|-----|------------------|
| `token` | Fluxer Developer Portal → Bot Token |
| `mongodb.uri` | MongoDB Atlas connection string |
| `fluxerClientId` | Fluxer Developer Portal → Application ID |
| `fluxerClientSecret` | Fluxer Developer Portal → Client Secret |
| `webBaseUrl` | Public URL of your server e.g. `http://YOUR_IP:3420` |

**Example `config.json`:**
```json
{
  "token": "YOUR_BOT_TOKEN",
  "prefix": "&",
  "mongodb": {
    "uri": "mongodb+srv://...",
    "database": "fluxer_casino"
  },
  "fluxerClientId": "1514719637881749504",
  "fluxerClientSecret": "YOUR_CLIENT_SECRET",
  "webBaseUrl": "http://YOUR_VPS_IP:3420"
}
```

### 3. Add OAuth2 Redirect URI

In the **Fluxer Developer Portal** (the page you screenshotted):
1. Scroll to **Application information → Allowed redirect URIs**
2. Add: `http://YOUR_VPS_IP:3420/oauth/callback`
3. Save

### 4. Start
```bash
npm start
# or
docker compose up -d
```

## Commands

| Command | Description |
|---------|-------------|
| `&bal` / `&balance` | Check your FC balance |
| `&daily` | Claim daily FC reward |
| `&slots <bet>` | Slot machine |
| `&blackjack <bet>` | Blackjack |
| `&coinflip <bet>` | Coin flip |
| `&dice <bet>` | Dice roll |
| `&roulette <bet> <number>` | Roulette |
| `&crash <bet>` | Crash game |
| `&pay @user <amount>` | Send FC to another user |
| `&leaderboard` | Global richest players |
| `&bandit` | Link to the web slot machine |
| `&help` | Full command list |

## Web Slot Machine

Users visit `http://YOUR_IP:3420/play`, log in with Fluxer OAuth2, and spin using their global FC balance.
