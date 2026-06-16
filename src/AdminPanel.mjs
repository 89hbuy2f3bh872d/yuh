/**
 * AdminPanel.mjs
 * Serves the /admin/panel dashboard.
 * Access is restricted to a single hardcoded Fluxer user ID.
 * Authentication re-uses the existing Fluxer OAuth session cookie (sid/uid)
 * that WebServer already sets — no separate login needed.
 */

const ADMIN_USER_ID = "1514719637881749504";

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function fmt(n) { return Number(n ?? 0).toLocaleString("en-US"); }

function timeAgo(ms) {
  if (!ms) return "never";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth;font-size:14px}
body{background:#07100a;color:#d4eed4;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0a1a0c}::-webkit-scrollbar-thumb{background:#2ecc7144;border-radius:99px}
/* Layout */
.layout{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.sidebar{background:#050e07;border-right:1px solid #1a3a1e;padding:1.2rem .9rem;display:flex;flex-direction:column;gap:.25rem;position:sticky;top:0;height:100vh;overflow-y:auto}
.logo{display:flex;align-items:center;gap:.5rem;padding:.4rem .5rem 1rem;border-bottom:1px solid #1a3a1e;margin-bottom:.5rem}
.logo-icon{font-size:1.4rem}
.logo-text{font-size:.92rem;font-weight:900;color:#2ecc71;letter-spacing:-.01em}
.logo-sub{font-size:.58rem;color:#3a6b3a;letter-spacing:.08em;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:.5rem;padding:.42rem .65rem;border-radius:7px;font-size:.78rem;font-weight:600;color:#7ab87a;cursor:pointer;transition:background .15s,color .15s;border:none;background:none;width:100%;text-align:left}
.nav-item:hover,.nav-item.active{background:#0d2b12;color:#2ecc71}
.nav-item .ni{font-size:.9rem;width:16px;text-align:center}
.nav-section{font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;color:#2a4a2a;padding:.7rem .65rem .25rem;font-weight:700}
.main{padding:1.5rem 1.8rem;overflow-x:hidden}
/* Header */
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.4rem;gap:1rem}
.page-title{font-size:1.1rem;font-weight:900;color:#e8ffe8}
.page-sub{font-size:.7rem;color:#4a8a4a;margin-top:.15rem}
.badge{display:inline-flex;align-items:center;gap:.3rem;background:#0a2b0e;border:1px solid #2ecc7133;border-radius:99px;padding:.18rem .55rem;font-size:.62rem;font-weight:700;color:#2ecc71}
.badge-dot{width:6px;height:6px;background:#2ecc71;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* KPI cards */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:.75rem;margin-bottom:1.5rem}
.kpi{background:#0a1f0e;border:1px solid #1e4a22;border-radius:10px;padding:.9rem 1rem;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--kc,#2ecc71),transparent);opacity:.7}
.kpi-label{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#4a8a4a;margin-bottom:.35rem}
.kpi-value{font-size:1.5rem;font-weight:900;color:#e8ffe8;letter-spacing:-.02em;line-height:1}
.kpi-sub{font-size:.62rem;color:#4a8a4a;margin-top:.3rem}
/* Section */
.section{margin-bottom:1.8rem}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem}
.section-title{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#2ecc71;display:flex;align-items:center;gap:.4rem}
.section-title::before{content:"";display:block;width:3px;height:13px;background:#2ecc71;border-radius:2px}
/* Table */
.tbl-wrap{background:#081508;border:1px solid #1a3a1e;border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead tr{background:#0a1f0e}
th{padding:.5rem .75rem;font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a8a4a;text-align:left;border-bottom:1px solid #1a3a1e;white-space:nowrap}
td{padding:.48rem .75rem;font-size:.74rem;color:#b8dcb8;border-bottom:1px solid #0e2512;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:#0a1f0e44}
.uid{font-family:monospace;font-size:.65rem;color:#4a8a4a}
.bal-val{font-weight:700;color:#2ecc71}
.bar-wrap{width:120px;background:#0e2512;border-radius:99px;height:5px;display:inline-block;vertical-align:middle;overflow:hidden}
.bar-inner{height:100%;background:linear-gradient(90deg,#1a7a3a,#2ecc71);border-radius:99px;min-width:2px}
/* Command pills */
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.55rem}
.cmd-card{background:#081508;border:1px solid #1a3a1e;border-radius:8px;padding:.6rem .8rem;display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.cmd-name{font-size:.72rem;font-weight:700;color:#a8dca8;font-family:monospace}
.cmd-count{font-size:.92rem;font-weight:900;color:#2ecc71}
/* Guild list */
.guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.65rem}
.guild-card{background:#081508;border:1px solid #1a3a1e;border-radius:9px;padding:.7rem .85rem}
.guild-name{font-size:.78rem;font-weight:700;color:#c8f0c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.guild-id{font-size:.62rem;color:#4a8a4a;font-family:monospace;margin-top:.1rem}
.guild-meta{display:flex;gap:.6rem;margin-top:.45rem;flex-wrap:wrap}
.guild-tag{font-size:.6rem;background:#0d2b12;border:1px solid #2ecc7122;color:#4ab84a;padding:.1rem .4rem;border-radius:4px;font-weight:600}
/* Daily chart */
.chart-wrap{background:#081508;border:1px solid #1a3a1e;border-radius:10px;padding:1rem 1.2rem}
.bar-chart{display:flex;align-items:flex-end;gap:4px;height:80px;margin-top:.5rem}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0}
.bar-col-bar{width:100%;background:linear-gradient(180deg,#2ecc71,#1a7a3a);border-radius:3px 3px 0 0;min-height:2px;transition:opacity .2s}
.bar-col-bar:hover{opacity:.7}
.bar-col-lbl{font-size:.5rem;color:#4a8a4a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:30px;text-align:center}
/* Access denied */
.denied{min-height:100vh;display:flex;align-items:center;justify-content:center}
.denied-card{background:#0e0507;border:2px solid #7a1a2a44;border-radius:14px;padding:2.5rem 2rem;max-width:380px;text-align:center;box-shadow:0 0 40px #ff000011}
.denied-icon{font-size:3rem;margin-bottom:.5rem}
.denied-title{font-size:1.2rem;font-weight:900;color:#e05050;margin-bottom:.5rem}
.denied-msg{font-size:.78rem;color:#a87878;line-height:1.6;margin-bottom:1rem}
.denied-id{font-family:monospace;font-size:.65rem;color:#7a4a4a;background:#1a0808;padding:.25rem .6rem;border-radius:5px;display:inline-block}
/* Responsive */
@media(max-width:700px){.layout{grid-template-columns:1fr}.sidebar{display:none}.main{padding:1rem}}
`;

function deniedPage(uid) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Access Denied</title><style>${CSS}</style></head><body>
<div class="denied">
  <div class="denied-card">
    <div class="denied-icon">🔒</div>
    <div class="denied-title">Access Denied</div>
    <div class="denied-msg">This admin panel is restricted to authorised personnel only.<br>Your identity has been logged.</div>
    <div class="denied-id">${esc(uid ?? "not logged in")}</div>
  </div>
</div></body></html>`;
}

function loginRequiredPage(loginUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Admin — Login</title><style>${CSS}</style></head><body>
<div class="denied">
  <div class="denied-card">
    <div class="denied-icon">🎰</div>
    <div class="denied-title" style="color:#2ecc71">Admin Login</div>
    <div class="denied-msg">You must be logged in with an authorised Fluxer account to access the admin panel.</div>
    <a href="${esc(loginUrl)}" style="display:inline-flex;align-items:center;gap:.5rem;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-weight:900;padding:.7rem 1.4rem;border-radius:8px;font-size:.85rem;margin-top:.3rem">🔑 Login with Fluxer</a>
  </div>
</div></body></html>`;
}

function buildPage(data) {
  const { globals, commands, guilds, daily, topUsers, buildAt } = data;

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const totalCmds = commands.reduce((s, c) => s + (c.count ?? 0), 0);
  const kpis = [
    { label: "Total Users",    value: fmt(globals.totalUsers),   sub: "in MongoDB",          color: "#2ecc71" },
    { label: "FC in Circulation", value: fmt(globals.totalBalance), sub: "sum of all balances", color: "#f0c040" },
    { label: "Total Bets",     value: fmt(globals.totalLost),    sub: "FC wagered",           color: "#e05050" },
    { label: "Total Paid Out", value: fmt(globals.totalWon),     sub: "FC won by users",      color: "#2ecc71" },
    { label: "Games Played",   value: fmt(globals.totalGames),   sub: "all time",             color: "#60c0f0" },
    { label: "Servers",        value: fmt(guilds.length),        sub: "bot is in",            color: "#b060f0" },
    { label: "Cmd Invocations",value: fmt(totalCmds),            sub: "all-time",             color: "#f08020" },
    { label: "Unique Cmds",    value: fmt(commands.length),      sub: "distinct commands",    color: "#40c0a0" },
  ];
  const kpiHtml = kpis.map(k => `
    <div class="kpi" style="--kc:${k.color}">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value" style="color:${k.color}">${esc(k.value)}</div>
      <div class="kpi-sub">${esc(k.sub)}</div>
    </div>`).join("");

  // ── Commands ───────────────────────────────────────────────────────────────
  const cmdHtml = commands.length
    ? commands.map(c => `
      <div class="cmd-card">
        <span class="cmd-name">/${esc(String(c._id).replace(/^cmd:/,""))}</span>
        <span class="cmd-count">${fmt(c.count)}</span>
      </div>`).join("")
    : `<p style="color:#4a8a4a;font-size:.75rem">No command data yet — CommandHandler.recordCommand() will populate this.</p>`;

  // ── Daily chart ─────────────────────────────────────────────────────────────
  const sortedDaily = [...daily].sort((a, b) => a._id < b._id ? -1 : 1);
  const maxDaily    = Math.max(...sortedDaily.map(d => d.total ?? 0), 1);
  const chartBars   = sortedDaily.map(d => {
    const pct = Math.round(((d.total ?? 0) / maxDaily) * 100);
    const lbl = String(d._id ?? "").slice(5); // MM-DD
    return `<div class="bar-col" title="${esc(d._id)}: ${fmt(d.total)} cmds">
      <div class="bar-col-bar" style="height:${pct}%"></div>
      <div class="bar-col-lbl">${esc(lbl)}</div>
    </div>`;
  }).join("");
  const chartHtml = `<div class="chart-wrap">
    <div class="section-title" style="margin-bottom:.5rem">📅 Command Activity (last 14 days)</div>
    <div class="bar-chart">${chartBars || '<p style="color:#4a8a4a;font-size:.7rem">No data yet.</p>'}</div>
  </div>`;

  // ── Guilds ─────────────────────────────────────────────────────────────────
  const guildHtml = guilds.length
    ? guilds.map(g => `
      <div class="guild-card">
        <div class="guild-name">${esc(g.name ?? g._id)}</div>
        <div class="guild-id">${esc(g._id)}</div>
        <div class="guild-meta">
          <span class="guild-tag">👥 ${fmt(g.memberCount ?? "?")}</span>
          <span class="guild-tag">🕐 ${esc(timeAgo(g.lastSeen))}</span>
          ${g.joinedAt ? `<span class="guild-tag">📅 joined ${esc(new Date(g.joinedAt).toLocaleDateString())}</span>` : ""}
        </div>
      </div>`).join("")
    : `<p style="color:#4a8a4a;font-size:.75rem">No guild data yet — upsertGuild() will populate this once the bot sees activity.</p>`;

  // ── Top users ──────────────────────────────────────────────────────────────
  const maxBal  = Math.max(...topUsers.map(u => u.bal ?? 0), 1);
  const userRows = topUsers.map((u, i) => {
    const pct = Math.round(((u.bal ?? 0) / maxBal) * 100);
    return `<tr>
      <td style="color:#4a8a4a;font-weight:700;width:28px">#${i + 1}</td>
      <td class="uid">${esc(u._id)}</td>
      <td class="bal-val">${fmt(u.bal)}</td>
      <td><span class="bar-wrap"><span class="bar-inner" style="width:${pct}%"></span></span></td>
      <td style="color:#4a8a4a">${fmt(u.gp)}</td>
      <td style="color:#e07070">${fmt(u.tl)}</td>
      <td style="color:#70e090">${fmt(u.tw)}</td>
    </tr>`;
  }).join("");

  const refreshedAt = new Date(buildAt).toLocaleTimeString("en-US", { hour12: false });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Panel — SirGreen Casino</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="logo">
      <span class="logo-icon">🎰</span>
      <div><div class="logo-text">SirGreen</div><div class="logo-sub">Admin Panel</div></div>
    </div>
    <span class="nav-section">Overview</span>
    <button class="nav-item active" onclick="scrollTo({top:0,behavior:'smooth'})">
      <span class="ni">📊</span> Dashboard
    </button>
    <span class="nav-section">Data</span>
    <button class="nav-item" onclick="document.getElementById('sec-guilds').scrollIntoView({behavior:'smooth'})">
      <span class="ni">🌐</span> Servers
    </button>
    <button class="nav-item" onclick="document.getElementById('sec-cmds').scrollIntoView({behavior:'smooth'})">
      <span class="ni">⌨️</span> Commands
    </button>
    <button class="nav-item" onclick="document.getElementById('sec-users').scrollIntoView({behavior:'smooth'})">
      <span class="ni">👥</span> Top Users
    </button>
    <button class="nav-item" onclick="document.getElementById('sec-activity').scrollIntoView({behavior:'smooth'})">
      <span class="ni">📅</span> Activity
    </button>
    <div style="flex:1"></div>
    <a href="/logout" style="display:block;font-size:.65rem;color:#3a6b3a;padding:.4rem .65rem;border-radius:6px;transition:color .15s" onmouseover="this.style.color='#e05050'" onmouseout="this.style.color='#3a6b3a'">⏏ Logout</a>
    <div style="font-size:.58rem;color:#1e3a1e;padding:.3rem .65rem">Refreshed ${esc(refreshedAt)}</div>
  </aside>

  <!-- Main -->
  <main class="main">
    <div class="page-header">
      <div>
        <div class="page-title">Bot Overview Dashboard</div>
        <div class="page-sub">sirgreen.online/admin/panel · restricted access</div>
      </div>
      <div class="badge"><span class="badge-dot"></span> Live</div>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid">${kpiHtml}</div>

    <!-- Activity chart -->
    <div class="section" id="sec-activity">${chartHtml}</div>

    <!-- Servers -->
    <div class="section" id="sec-guilds">
      <div class="section-header">
        <div class="section-title">🌐 Servers (${esc(guilds.length)})</div>
      </div>
      <div class="guild-grid">${guildHtml}</div>
    </div>

    <!-- Commands -->
    <div class="section" id="sec-cmds">
      <div class="section-header">
        <div class="section-title">⌨️ Command Usage</div>
      </div>
      <div class="cmd-grid">${cmdHtml}</div>
    </div>

    <!-- Top Users -->
    <div class="section" id="sec-users">
      <div class="section-header">
        <div class="section-title">👥 Top 20 Users by Balance</div>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>#</th><th>User ID</th><th>Balance (FC)</th><th>Bar</th><th>Games</th><th>Lost</th><th>Won</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
    </div>
  </main>
</div>
</body></html>`;
}

export class AdminPanel {
  /** @param {import('./Database.mjs').Database} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Returns true if the given userId is the authorised admin.
   */
  isAdmin(userId) {
    return String(userId ?? "") === ADMIN_USER_ID;
  }

  /**
   * Renders the full dashboard HTML.
   * Caller is responsible for the session check.
   */
  async render() {
    const [globals, commands, guilds, daily, topUsers] = await Promise.all([
      this.db.getGlobalTotals(),
      this.db.getCommandStats(),
      this.db.getGuilds(),
      this.db.getDailyStats(14),
      this.db.getAdminUserStats(20),
    ]);
    return buildPage({ globals, commands, guilds, daily, topUsers, buildAt: Date.now() });
  }

  /** Convenience: return the login-required page. */
  loginRequired(loginUrl) { return loginRequiredPage(loginUrl); }

  /** Convenience: return the access-denied page for a logged-in non-admin. */
  accessDenied(uid) { return deniedPage(uid); }
}
