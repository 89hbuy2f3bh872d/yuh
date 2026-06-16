/**
 * Admin panel renderer — /admin/panel
 * Only accessible to ADMIN_USER_ID via the existing Fluxer OAuth session.
 */

export const ADMIN_USER_ID = "1514719637881749504";

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function fmt(n) { return Number(n ?? 0).toLocaleString("en-US"); }

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export function renderAdminPanel({ guilds, cmdStats, dailyStats, topUsers, totals, generatedAt }) {
  const totalCmds = cmdStats.reduce((s, c) => s + (c.count ?? 0), 0);

  // Command rows
  const cmdRows = cmdStats.map(c => {
    const name = String(c._id ?? "").replace("cmd:", "");
    const pct  = totalCmds > 0 ? ((c.count / totalCmds) * 100).toFixed(1) : "0.0";
    return `<tr>
      <td><code>${esc(name)}</code></td>
      <td>${fmt(c.count)}</td>
      <td>
        <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
      </td>
      <td>${pct}%</td>
    </tr>`;
  }).join("");

  // Guild rows
  const guildRows = guilds.map(g => `<tr>
    <td>${g.icon ? `<img src="${esc(g.icon)}" class="guild-icon" alt="">` : `<span class="guild-placeholder">🎰</span>`} ${esc(g.name ?? g._id)}</td>
    <td><code>${esc(g._id)}</code></td>
    <td>${fmt(g.memberCount)}</td>
    <td>${timeAgo(g.lastSeen)}</td>
    <td>${timeAgo(g.joinedAt)}</td>
  </tr>`).join("");

  // Top user rows
  const userRows = topUsers.map((u, i) => `<tr>
    <td>#${i+1}</td>
    <td><code>${esc(u._id)}</code></td>
    <td>${fmt(u.bal)} FC</td>
    <td>${fmt(u.gp)}</td>
    <td>${fmt(u.tw)} FC</td>
    <td>${fmt(u.tl)} FC</td>
  </tr>`).join("");

  // Daily activity chart data
  const days = [...dailyStats].reverse();
  const maxDay = Math.max(1, ...days.map(d => d.total ?? 0));
  const dayBars = days.map(d => {
    const h = Math.max(4, Math.round(((d.total ?? 0) / maxDay) * 120));
    const label = String(d._id ?? "").replace("daily:", "").slice(5); // MM-DD
    return `<div class="day-col">
      <div class="day-bar" style="height:${h}px" title="${esc(d._id?.replace('daily:',''))}: ${fmt(d.total)} commands"></div>
      <div class="day-label">${esc(label)}</div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Panel — SirGreen Casino</title>
<style>
:root{
  --bg:#060e06;--surface:#0a1a0a;--surface2:#0e230e;--border:#2ecc7120;
  --accent:#2ecc71;--accent2:#27ae60;--text:#e2ffe2;--muted:#7ab87a;
  --red:#e74c3c;--gold:#f1c40f;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:.875rem;min-height:100vh}
a{color:var(--accent);text-decoration:none}
code{font-family:monospace;font-size:.8em;background:#0a1f0a;padding:.1em .35em;border-radius:4px;color:#a8e6a8}
.topbar{display:flex;align-items:center;gap:.75rem;padding:.6rem 1.4rem;background:rgba(6,14,6,.96);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.topbar-logo{font-weight:900;color:var(--accent);font-size:.95rem}
.topbar-spacer{flex:1}
.topbar-meta{font-size:.7rem;color:var(--muted)}
.logout{font-size:.68rem;color:#3a6b3a;border-bottom:1px solid var(--border)}
.logout:hover{color:var(--accent)}
.wrap{padding:1.4rem;max-width:1300px;margin:0 auto}
.page-title{font-size:1.3rem;font-weight:900;color:var(--accent);margin-bottom:1.4rem;text-shadow:0 0 14px #2ecc7144}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.75rem;margin-bottom:1.6rem}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem}
.kpi-label{font-size:.64rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:.3rem}
.kpi-value{font-size:1.5rem;font-weight:900;color:var(--accent)}
.kpi-sub{font-size:.65rem;color:var(--muted);margin-top:.15rem}
.section{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:1.2rem;overflow:hidden}
.section-head{padding:.7rem 1rem;border-bottom:1px solid var(--border);font-size:.72rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:.4rem}
.section-body{padding:1rem}
table{width:100%;border-collapse:collapse}
th{font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:.4rem .6rem;text-align:left;border-bottom:1px solid var(--border)}
td{padding:.45rem .6rem;border-bottom:1px solid #2ecc7109;font-size:.78rem;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#2ecc7106}
.bar-wrap{width:120px;height:6px;background:#0e230e;border-radius:99px;overflow:hidden}
.bar{height:100%;background:linear-gradient(90deg,var(--accent2),var(--accent));border-radius:99px}
.guild-icon{width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:.35rem}
.guild-placeholder{font-size:1rem;vertical-align:middle;margin-right:.35rem}
.chart-wrap{display:flex;align-items:flex-end;gap:3px;height:140px;padding:.5rem .25rem .25rem}
.day-col{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0}
.day-bar{width:100%;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:3px 3px 0 0;transition:opacity .2s;cursor:default}
.day-bar:hover{opacity:.7}
.day-label{font-size:.52rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:36px;text-align:center}
.badge{display:inline-block;font-size:.6rem;font-weight:700;padding:.15em .5em;border-radius:99px;letter-spacing:.05em}
.badge-green{background:#2ecc7122;color:var(--accent)}
.gen{font-size:.62rem;color:#2a4a2a;text-align:right;margin-top:.8rem}
@media(max-width:600px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.bar-wrap{width:70px}.chart-wrap{gap:2px}}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">🎰 SirGreen Admin</span>
  <span class="topbar-spacer"></span>
  <span class="topbar-meta">Restricted access</span>
  <a href="/logout" class="logout">logout</a>
</div>
<div class="wrap">
  <div class="page-title">📊 Dashboard</div>

  <!-- KPIs -->
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Servers</div><div class="kpi-value">${fmt(guilds.length)}</div><div class="kpi-sub">guilds with the bot</div></div>
    <div class="kpi"><div class="kpi-label">Registered Users</div><div class="kpi-value">${fmt(totals.totalUsers)}</div><div class="kpi-sub">in database</div></div>
    <div class="kpi"><div class="kpi-label">Commands Run</div><div class="kpi-value">${fmt(totalCmds)}</div><div class="kpi-sub">all-time</div></div>
    <div class="kpi"><div class="kpi-label">Games Played</div><div class="kpi-value">${fmt(totals.totalGames)}</div><div class="kpi-sub">all-time</div></div>
    <div class="kpi"><div class="kpi-label">Total FC in Circulation</div><div class="kpi-value">${fmt(totals.totalBalance)}</div><div class="kpi-sub">FluxCoins</div></div>
    <div class="kpi"><div class="kpi-label">Total FC Won</div><div class="kpi-value" style="color:var(--gold)">${fmt(totals.totalWon)}</div><div class="kpi-sub">by players</div></div>
    <div class="kpi"><div class="kpi-label">Total FC Lost</div><div class="kpi-value" style="color:var(--red)">${fmt(totals.totalLost)}</div><div class="kpi-sub">by players</div></div>
    <div class="kpi"><div class="kpi-label">House Edge</div><div class="kpi-value">${totals.totalLost > 0 ? (((totals.totalLost - totals.totalWon) / totals.totalLost)*100).toFixed(1) : "—"}%</div><div class="kpi-sub">net house gain</div></div>
  </div>

  <!-- Daily activity chart -->
  <div class="section">
    <div class="section-head">📈 Command Activity — Last 14 Days</div>
    <div class="section-body">
      <div class="chart-wrap">${dayBars || '<span style="color:var(--muted);font-size:.75rem">No data yet</span>'}</div>
    </div>
  </div>

  <!-- Command stats -->
  <div class="section">
    <div class="section-head">⌨️ Command Usage</div>
    <div class="section-body">
      ${cmdRows ? `<table><thead><tr><th>Command</th><th>Uses</th><th>Share</th><th>%</th></tr></thead><tbody>${cmdRows}</tbody></table>` : '<p style="color:var(--muted);font-size:.78rem">No commands recorded yet.</p>'}
    </div>
  </div>

  <!-- Guilds -->
  <div class="section">
    <div class="section-head">🌐 Guilds (${fmt(guilds.length)})</div>
    <div class="section-body">
      ${guildRows ? `<table><thead><tr><th>Server</th><th>ID</th><th>Members</th><th>Last Active</th><th>Bot Added</th></tr></thead><tbody>${guildRows}</tbody></table>` : '<p style="color:var(--muted);font-size:.78rem">No guild data yet — guilds are recorded as messages arrive.</p>'}
    </div>
  </div>

  <!-- Top users -->
  <div class="section">
    <div class="section-head">👑 Top 20 Users by Balance</div>
    <div class="section-body">
      ${userRows ? `<table><thead><tr><th>Rank</th><th>User ID</th><th>Balance</th><th>Games</th><th>Won</th><th>Lost</th></tr></thead><tbody>${userRows}</tbody></table>` : '<p style="color:var(--muted);font-size:.78rem">No users yet.</p>'}
    </div>
  </div>

  <div class="gen">Generated ${esc(generatedAt)} · <a href="/admin/panel">Refresh</a></div>
</div>
</body>
</html>`;
}
