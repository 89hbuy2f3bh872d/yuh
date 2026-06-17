// PM2 — two processes that share Mongo + SpacetimeDB.
//   sirgreen-bot : Node (Fluxer Discord bot, command handling)
//   sirgreen-web : Bun + Elysia (website, realtime WS, money endpoints → STDB)
//
// Start:  pm2 start ecosystem.config.cjs && pm2 save
// Bun must be on PATH (curl -fsSL https://bun.sh/install | bash).
module.exports = {
  apps: [
    {
      name: "sirgreen-bot",
      script: "index.mjs",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "350M",
      env: { NODE_ENV: "production" },
    },
    {
      name: "sirgreen-web",
      script: "web/server.ts",
      interpreter: "bun",          // PM2 runs: bun web/server.ts
      exec_mode: "fork",
      // Bun's server is async + very fast; one instance saturates a small VPS.
      // To use >1 core, bump instances — server.ts sets reusePort so they share :8080.
      instances: 1,
      autorestart: true,
      max_memory_restart: "500M",
      env: { NODE_ENV: "production" },
    },
  ],
};
