/**
 * AdminPanel — serves /admin/panel
 * Access is restricted to a single owner user ID.
 * Auth reuses the existing Fluxer OAuth session cookie (uid + sid).
 */

const ADMIN_UID = "1514719637881749504";

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function fmtNum(n) {
  return Number(n ?? 0).toLocaleString("en-US");
}

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export class AdminPanel {
  constructor(db) {
    this.db = db;
  }

  /** Returns true if the request is from the authorised admin. */
  async isAuthorised(req) {
    const c = parseCookies(req);
    if (!c.uid || !c.sid) return false;
    if (c.uid !== ADMIN_UID) return false;
    try {
      return await this.db.validateSession(c.uid, c.sid);
    } catch { return false; }
  }

  async handleRequest(req, res) {
    const authed = await this.isAuthorised(req);
    if (!authed) {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }

    // Gather all data in parallel
    const [globals, cmdStats, dailyStats, guilds, topUsers] = await Promise.all([
      this.db.getGlobalTotals().catch(() => ({})),
      this.db.getCommandStats().catch(() => []),
      this.db.getDailyStats(14).catch(() => []),
      this.db.getGuilds().catch(() => []),
      this.db.getAdminUserStats(25).catch(() => []),
    ]);

    res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" });
    res.end(buildPage(globals, cmdStats, dailyStats, guilds, topUsers));
  }
}

// ─── JSON data blobs embedded into the page ──────────────────────────────────

function buildPage(globals, cmdStats, dailyStats, guilds, topUsers) {
  const houseEdge = globals.totalLost > 0
    ? (((globals.totalLost - globals.totalWon) / globals.totalLost) * 100).toFixed(2)
    : "0.00";

  // Prepare chart data
  const sortedDaily = [...dailyStats].sort((a,b) => a._id < b._id ? -1 : 1);
  const dailyLabels = sortedDaily.map(d => d._id);
  const dailyTotals = sortedDaily.map(d => d.total ?? 0);

  const cmdLabels  = cmdStats.slice(0, 15).map(c => String(c._id).replace("cmd:", ""));
  const cmdCounts  = cmdStats.slice(0, 15).map(c => c.count ?? 0);

  const totalCmds  = cmdStats.reduce((s, c) => s + (c.count ?? 0), 0);

  // Guild rows
  const guildRows = guilds.map(g => `
    <tr>
      <td><span class="guild-icon">${g.icon ? `<img src="https://cdn.discordapp.com/icons/${esc(g._id)}/${esc(g.icon)}.webp?size=32" alt="" width="32" height="32" loading="lazy">` : "🌐"}</span></td>
      <td><strong>${esc(g.name ?? g._id)}</strong><br><span class="muted">${esc(g._id)}</span></td>
      <td>${fmtNum(g.memberCount)}</td>
      <td>${timeAgo(g.lastSeen)}</td>
      <td>${timeAgo(g.joinedAt)}</td>
    </tr>`).join("");

  // Top user rows
  const userRows = topUsers.map((u, i) => `
    <tr>
      <td class="rank">#${i+1}</td>
      <td><code>${esc(u._id)}</code></td>
      <td class="num">${fmtNum(u.bal)} FC</td>
      <td class="num">${fmtNum(u.tw)} FC</td>
      <td class="num">${fmtNum(u.tl)} FC</td>
      <td class="num">${fmtNum(u.gp)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SirGreen Admin Panel</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg:        #060e06;
  --surface:   #0a1a0a;
  --surface2:  #0e230e;
  --border:    #2ecc7122;
  --accent:    #2ecc71;
  --accent2:   #27ae60;
  --text:      #e2ffe2;
  --muted:     #6aaa6a;
  --red:       #e74c3c;
  --gold:      #f1c40f;
  --radius:    10px;
  --shadow:    0 4px 20px #0008;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;font-size:14px}
a{color:var(--accent);text-decoration:none}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:var(--surface)}::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}

/* Nav */
.nav{position:sticky;top:0;z-index:100;background:rgba(6,14,6,.95);backdrop-filter:blur(14px);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.8rem;padding:.55rem 1.4rem;min-height:52px}
.nav-logo{display:flex;align-items:center;gap:.5rem;font-weight:900;color:var(--accent);font-size:1rem}
.nav-badge{background:#2ecc7118;border:1px solid #2ecc7133;color:#a8e6a8;font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:.18rem .45rem;border-radius:5px}
.nav-spacer{flex:1}
.nav-meta{font-size:.7rem;color:var(--muted)}

/* Layout */
.wrap{padding:1.4rem;max-width:1280px;margin:0 auto;display:flex;flex-direction:column;gap:1.4rem}

/* Section header */
.section-label{font-size:.72rem;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:.8rem;opacity:.8}

/* KPI cards */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:.9rem}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.35rem;box-shadow:var(--shadow)}
.kpi-label{font-size:.65rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.kpi-value{font-size:1.55rem;font-weight:900;color:var(--text);font-variant-numeric:tabular-nums;line-height:1.1}
.kpi-sub{font-size:.68rem;color:var(--muted)}
.kpi.accent .kpi-value{color:var(--accent)}
.kpi.gold   .kpi-value{color:var(--gold)}
.kpi.red    .kpi-value{color:var(--red)}

/* Charts */
.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:700px){.charts-row{grid-template-columns:1fr}}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.2rem;box-shadow:var(--shadow)}
.chart-card canvas{max-height:220px}

/* Tables */
.table-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
thead tr{background:var(--surface2);font-size:.67rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
th,td{padding:.6rem .85rem;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--surface2)}
.rank{color:var(--muted);font-weight:700}
.num{font-variant-numeric:tabular-nums;text-align:right}
.muted{color:var(--muted);font-size:.78em}
.guild-icon{display:inline-flex;align-items:center;gap:.4rem;vertical-align:middle}
.guild-icon img{border-radius:50%;width:28px;height:28px}

/* Command pills */
.cmd-list{display:flex;flex-wrap:wrap;gap:.5rem;padding:1rem}
.cmd-pill{background:var(--surface2);border:1px solid var(--border);border-radius:99px;padding:.3rem .75rem;font-size:.72rem;display:flex;align-items:center;gap:.4rem}
.cmd-pill .ct{background:#2ecc7122;color:var(--accent);font-weight:900;font-size:.7rem;border-radius:99px;padding:.1rem .38rem}

/* Footer */
.footer{font-size:.65rem;color:#2a4a2a;text-align:center;padding:.8rem}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-logo">🎰 SirGreen <span class="nav-badge">Admin</span></div>
  <div class="nav-spacer"></div>
  <span class="nav-meta">Loaded ${new Date().toUTCString()}</span>
</nav>

<div class="wrap">

  <!-- KPIs -->
  <div>
    <div class="section-label">Overview</div>
    <div class="kpi-grid">
      <div class="kpi accent">
        <div class="kpi-label">Total Users</div>
        <div class="kpi-value">${fmtNum(globals.totalUsers)}</div>
        <div class="kpi-sub">registered accounts</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Servers</div>
        <div class="kpi-value">${fmtNum(guilds.length)}</div>
        <div class="kpi-sub">guilds seen</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">FC in Circulation</div>
        <div class="kpi-value">${fmtNum(globals.totalBalance)}</div>
        <div class="kpi-sub">across all wallets</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total Games Played</div>
        <div class="kpi-value">${fmtNum(globals.totalGames)}</div>
        <div class="kpi-sub">all time</div>
      </div>
      <div class="kpi accent">
        <div class="kpi-label">Total FC Won</div>
        <div class="kpi-value">${fmtNum(globals.totalWon)}</div>
        <div class="kpi-sub">by users</div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Total FC Lost</div>
        <div class="kpi-value">${fmtNum(globals.totalLost)}</div>
        <div class="kpi-sub">by users</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">House Edge (net)</div>
        <div class="kpi-value">${houseEdge}%</div>
        <div class="kpi-sub">lost − won / lost</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Commands Run</div>
        <div class="kpi-value">${fmtNum(totalCmds)}</div>
        <div class="kpi-sub">all time</div>
      </div>
    </div>
  </div>

  <!-- Charts -->
  <div>
    <div class="section-label">Activity</div>
    <div class="charts-row">
      <div class="chart-card">
        <div class="section-label" style="margin-bottom:.6rem">Commands / Day (14d)</div>
        <canvas id="dailyChart"></canvas>
      </div>
      <div class="chart-card">
        <div class="section-label" style="margin-bottom:.6rem">Top Commands (all time)</div>
        <canvas id="cmdChart"></canvas>
      </div>
    </div>
  </div>

  <!-- Command pill breakdown -->
  <div>
    <div class="section-label">All Commands</div>
    <div class="table-card">
      <div class="cmd-list">
        ${cmdStats.map(c => `<div class="cmd-pill"><span>&amp;${esc(String(c._id).replace("cmd:",""))}</span><span class="ct">${fmtNum(c.count)}</span></div>`).join("")}
        ${cmdStats.length === 0 ? '<span style="color:var(--muted);font-size:.8rem;padding:.5rem">No data yet — commands will appear here once used.</span>' : ""}
      </div>
    </div>
  </div>

  <!-- Servers -->
  <div>
    <div class="section-label">Servers (${guilds.length})</div>
    <div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr><th></th><th>Server</th><th>Members</th><th>Last Active</th><th>First Seen</th></tr></thead>
          <tbody>${guildRows || '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1.5rem">No server data yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Top Users -->
  <div>
    <div class="section-label">Top 25 Users by Balance</div>
    <div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>#</th><th>User ID</th><th class="num">Balance</th><th class="num">Total Won</th><th class="num">Total Lost</th><th class="num">Games</th></tr></thead>
          <tbody>${userRows || '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:1.5rem">No users yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

</div>

<div class="footer">SirGreen Casino Admin &mdash; restricted access</div>

<script>
(function(){
  const ACCENT = "#2ecc71";
  const GRID   = "rgba(46,204,113,0.08)";
  const TEXT   = "#6aaa6a";
  Chart.defaults.color = TEXT;
  Chart.defaults.borderColor = GRID;

  // Daily chart
  new Chart(document.getElementById("dailyChart"), {
    type: "line",
    data: {
      labels: ${JSON.stringify(dailyLabels)},
      datasets: [{
        label: "Commands",
        data: ${JSON.stringify(dailyTotals)},
        borderColor: ACCENT,
        backgroundColor: "rgba(46,204,113,0.08)",
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: ACCENT,
        fill: true,
        tension: 0.35,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: GRID }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: GRID }, ticks: { font: { size: 10 } }, beginAtZero: true }
      }
    }
  });

  // Command bar chart
  new Chart(document.getElementById("cmdChart"), {
    type: "bar",
    data: {
      labels: ${JSON.stringify(cmdLabels)},
      datasets: [{
        label: "Uses",
        data: ${JSON.stringify(cmdCounts)},
        backgroundColor: "rgba(46,204,113,0.55)",
        borderColor: ACCENT,
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: GRID }, ticks: { font: { size: 10 } }, beginAtZero: true },
        y: { grid: { color: GRID }, ticks: { font: { size: 10 } } }
      }
    }
  });
})();
</script>

</body>
</html>`;
}
