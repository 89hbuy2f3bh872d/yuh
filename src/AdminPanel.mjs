/**
 * AdminPanel.mjs
 * Serves the /admin/panel dashboard.
 * Access is restricted to a single hardcoded Fluxer user ID.
 * Authentication re-uses the existing Fluxer OAuth session cookie (sid/uid)
 * that WebServer already sets — no separate login needed.
 */

const ADMIN_USER_ID = "1512241609448620032";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString("en-US");
}

function pct(value, max) {
  if (!max) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((Number(value ?? 0) / max) * 100)),
  );
}

function timeAgo(ms) {
  if (!ms) return "never";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Buckets a guild's lastSeen timestamp into a freshness tier used for the
 *  colour-coded left edge on its card — recent activity reads brighter. */
function freshness(ms) {
  if (!ms) return { tone: "var(--text-dim)", label: "no activity" };
  const sec = (Date.now() - ms) / 1000;
  if (sec < 3600) return { tone: "var(--accent)", label: "active now" };
  if (sec < 86400) return { tone: "var(--gold)", label: "active today" };
  return { tone: "var(--border)", label: "quiet" };
}

// ── Page registry — drives both the sidebar nav and the page sections ──────
// Each entry's colour becomes that section's "chip" identity throughout the UI.
const PAGES = [
  { id: "overview", label: "Dashboard", color: "var(--accent)" },
  { id: "servers", label: "Servers", color: "var(--purple)" },
  { id: "commands", label: "Commands", color: "var(--orange)" },
  { id: "users", label: "Top Users", color: "var(--blue)" },
  { id: "activity", label: "Activity", color: "var(--gold)" },
  { id: "cases", label: "Case Tiers", color: "var(--teal)" },
  { id: "balances", label: "Balances", color: "var(--red)" },
  { id: "battles", label: "Battles", color: "var(--orange)" },
];

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">`;

const CSS = `
:root{
  --bg:#0a0f0c; --bg-deep:#070b07;
  --surface:#111a15; --surface-2:#162019;
  --border:#1e3028; --border-soft:#162019;
  --text-bright:#e0efe4; --text:#b8dcb8; --text-dim:#5a8a6e; --text-faint:#2a4a2a;
  --accent:#2ecc71; --accent-bright:#3ee084;
  --gold:#f0c040; --purple:#b060f0; --blue:#60c0f0; --orange:#f08020; --red:#e05050; --teal:#40c0a0;
  --font-body:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;font-size:14px}
body{background:var(--bg);background-image:radial-gradient(circle at 14% 0%,#0c2412 0%,transparent 55%);color:var(--text);font-family:var(--font-body);min-height:100vh}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent-bright);outline-offset:2px;border-radius:6px}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg-deep)}::-webkit-scrollbar-thumb{background:#2ecc7144;border-radius:99px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}

/* Layout */
.layout{display:grid;grid-template-columns:228px 1fr;min-height:100vh}
.sidebar{background:var(--bg-deep);border-right:1px solid var(--border-soft);padding:1.3rem 1rem;display:flex;flex-direction:column;gap:.2rem;position:sticky;top:0;height:100vh;overflow-y:auto}
.logo{display:flex;align-items:center;gap:.55rem;padding:.3rem .4rem 1.1rem;border-bottom:1px solid var(--border-soft);margin-bottom:.6rem}
.logo-icon{font-size:1.5rem;line-height:1}
.logo-text{font-family:var(--font-body);font-size:1rem;font-weight:900;color:var(--accent-bright);letter-spacing:-.01em}
.logo-sub{font-size:.58rem;color:var(--text-faint);letter-spacing:.1em;text-transform:uppercase;margin-top:.1rem}

.chip{width:18px;height:18px;border-radius:50%;border:2px dashed rgba(255,255,255,.38);background:var(--cc);flex-shrink:0;position:relative;transition:box-shadow .15s}
.chip::after{content:"";position:absolute;top:50%;left:50%;width:6px;height:6px;border-radius:50%;background:var(--bg-deep);transform:translate(-50%,-50%)}

.nav-item{display:flex;align-items:center;gap:.6rem;padding:.5rem .65rem;border-radius:8px;font-size:.79rem;font-weight:600;color:var(--text-dim);width:100%;text-align:left;transition:background .15s,color .15s}
.nav-item:hover{background:var(--surface);color:var(--text-bright)}
.nav-item.active{background:var(--surface);color:var(--text-bright)}
.nav-item.active .chip{box-shadow:0 0 0 3px color-mix(in srgb, var(--cc) 30%, transparent)}
.nav-section{font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint);padding:.75rem .65rem .3rem;font-weight:700}
.sidebar-foot{display:flex;flex-direction:column;gap:.15rem;padding:.5rem .65rem 0}
.sidebar-foot a{font-size:.65rem;color:var(--text-faint);padding:.3rem 0;transition:color .15s}
.sidebar-foot a:hover{color:var(--red)}
.sidebar-foot .ts{font-size:.58rem;color:var(--text-faint)}

.main{padding:1.7rem 2rem;overflow-x:hidden}

/* Pages — only the active one renders */
.page{display:none}
.page.page-active{display:block;animation:fadeIn .22s ease both}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* Header */
.page-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem;gap:1rem}
.page-eyebrow{font-size:.62rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--pc,var(--accent));margin-bottom:.3rem}
.page-title{font-family:var(--font-body);font-size:1.4rem;font-weight:800;color:var(--text-bright);letter-spacing:-.01em}
.page-sub{font-size:.74rem;color:var(--text-dim);margin-top:.3rem}
.badge{display:inline-flex;align-items:center;gap:.35rem;background:var(--surface);border:1px solid #2ecc7133;border-radius:99px;padding:.22rem .6rem;font-size:.62rem;font-weight:700;color:var(--accent);white-space:nowrap}
.badge-dot{width:6px;height:6px;background:var(--accent);border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* KPI cards */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:.8rem;margin-bottom:1.6rem}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:.95rem 1.05rem;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--kc,var(--accent)),transparent);opacity:.75}
.kpi-label{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);margin-bottom:.4rem}
.kpi-value{font-family:var(--font-body);font-size:1.55rem;font-weight:800;color:var(--text-bright);letter-spacing:-.02em;line-height:1}
.kpi-sub{font-size:.62rem;color:var(--text-dim);margin-top:.35rem}

/* Section */
.section{margin-bottom:1.8rem}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.8rem}
.section-title{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);display:flex;align-items:center;gap:.45rem}
.section-title::before{content:"";display:block;width:3px;height:13px;background:var(--accent);border-radius:2px}
.stat-row{display:flex;gap:.6rem;margin-bottom:1.1rem;flex-wrap:wrap}
.stat-pill{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:.55rem .9rem;font-size:.7rem;color:var(--text-dim)}
.stat-pill b{font-family:var(--font-mono);color:var(--text-bright);font-size:.82rem;margin-right:.3rem}

/* Table */
.tbl-wrap{background:var(--surface-2);border:1px solid var(--border);border-radius:11px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead tr{background:var(--surface)}
th{padding:.55rem .8rem;font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.5rem .8rem;font-size:.74rem;color:var(--text);border-bottom:1px solid var(--border-soft);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:#0a1f0e66}
.rank{font-weight:700;color:var(--text-dim);width:32px}
.rank.medal{font-size:.95rem}
.uid{font-family:var(--font-mono);font-size:.65rem;color:var(--text-dim)}
.bal-val{font-weight:700;color:var(--accent);font-family:var(--font-mono)}
.bar-wrap{width:120px;background:var(--border-soft);border-radius:99px;height:5px;display:inline-block;vertical-align:middle;overflow:hidden}
.bar-inner{height:100%;background:linear-gradient(90deg,#1a7a3a,var(--accent-bright));border-radius:99px;min-width:2px}

/* Command cards */
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.6rem}
.cmd-card{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:.7rem .9rem;display:flex;flex-direction:column;gap:.5rem}
.cmd-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.cmd-name{font-size:.74rem;font-weight:700;color:var(--text-bright);font-family:var(--font-mono)}
.cmd-count{font-family:var(--font-body);font-size:.95rem;font-weight:800;color:var(--orange)}
.cmd-bar{width:100%;background:var(--border-soft);border-radius:99px;height:4px;overflow:hidden}
.cmd-bar-inner{height:100%;background:linear-gradient(90deg,#a8500f,var(--orange));border-radius:99px;min-width:2px}

/* Guild cards */
.guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.7rem}
.guild-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--fc,var(--border));border-radius:9px;padding:.75rem .9rem}
.guild-name{font-size:.79rem;font-weight:700;color:var(--text-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.guild-id{font-size:.62rem;color:var(--text-dim);font-family:var(--font-mono);margin-top:.15rem}
.guild-meta{display:flex;gap:.5rem;margin-top:.55rem;flex-wrap:wrap}
.guild-tag{font-size:.6rem;background:var(--surface-2);border:1px solid #2ecc7122;color:#4ab84a;padding:.12rem .42rem;border-radius:4px;font-weight:600}
.guild-fresh{font-size:.6rem;font-weight:700;margin-top:.5rem;color:var(--fc,var(--text-dim))}

/* Chart */
.chart-wrap{background:var(--surface-2);border:1px solid var(--border);border-radius:11px;padding:1.1rem 1.3rem}
.bar-chart{display:flex;align-items:flex-end;gap:5px;height:140px;margin-top:.7rem}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:0;height:100%;justify-content:flex-end}
.bar-col-bar{width:100%;background:linear-gradient(180deg,var(--gold),#8a6a08);border-radius:3px 3px 0 0;min-height:2px;transition:opacity .2s}
.bar-col-bar:hover{opacity:.7}
.bar-col-lbl{font-size:.56rem;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34px;text-align:center;font-family:var(--font-mono)}

/* Empty state */
.empty{color:var(--text-dim);font-size:.78rem;background:var(--surface-2);border:1px dashed var(--border);border-radius:10px;padding:1.2rem;text-align:center}

/* Access denied / login */
.denied{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--font-body)}
.denied-card{background:#0e0507;border:2px solid #7a1a2a44;border-radius:14px;padding:2.5rem 2rem;max-width:380px;text-align:center;box-shadow:0 0 40px #ff000011}
.denied-icon{font-size:3rem;margin-bottom:.5rem}
.denied-title{font-family:var(--font-body);font-size:1.25rem;font-weight:800;color:var(--red);margin-bottom:.5rem}
.denied-msg{font-size:.78rem;color:#a87878;line-height:1.6;margin-bottom:1rem}
.denied-id{font-family:var(--font-mono);font-size:.65rem;color:#7a4a4a;background:#1a0808;padding:.25rem .6rem;border-radius:5px;display:inline-block}

/* Responsive */
@media(max-width:760px){.layout{grid-template-columns:1fr}.sidebar{display:none}.main{padding:1.1rem}}
`;

function shell(body, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONTS}<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function deniedPage(uid) {
  return shell(
    `<div class="denied">
  <div class="denied-card">
    <div class="denied-icon">🔒</div>
    <div class="denied-title">Access Denied</div>
    <div class="denied-msg">This admin panel is restricted to authorised personnel only.<br>Your identity has been logged.</div>
    <div class="denied-id">${esc(uid ?? "not logged in")}</div>
  </div>
</div>`,
    "Access Denied",
  );
}

function loginRequiredPage(loginUrl) {
  return shell(
    `<div class="denied">
  <div class="denied-card">
    <div class="denied-icon">🎰</div>
    <div class="denied-title" style="color:var(--accent)">Admin Login</div>
    <div class="denied-msg">You must be logged in with an authorised Fluxer account to access the admin panel.</div>
    <a href="${esc(loginUrl)}" style="display:inline-flex;align-items:center;gap:.5rem;background:var(--accent);color:#0a0f0c;font-weight:800;font-family:var(--font-body);padding:.7rem 1.4rem;border-radius:8px;font-size:.85rem;margin-top:.3rem">🔑 Login with Fluxer</a>
  </div>
</div>`,
    "Admin — Login",
  );
}

function pageHeader({ eyebrow, title, sub, color }) {
  return `<div class="page-header">
    <div>
      <div class="page-eyebrow" style="--pc:${color}">${esc(eyebrow)}</div>
      <div class="page-title">${esc(title)}</div>
      <div class="page-sub">${sub}</div>
    </div>
    <div class="badge"><span class="badge-dot"></span> Live</div>
  </div>`;
}

function buildPage(data, prefix) {
  const { globals, commands, guilds, daily, topUsers, buildAt } = data;
  const refreshedAt = new Date(buildAt).toLocaleTimeString("en-US", {
    hour12: false,
  });

  // ── Overview / KPIs ──────────────────────────────────────────────────────
  const totalCmds = commands.reduce((s, c) => s + (c.count ?? 0), 0);
  const kpis = [
    {
      label: "Total Users",
      value: fmt(globals.totalUsers),
      sub: "in MongoDB",
      color: "var(--accent)",
    },
    {
      label: "FC in Circulation",
      value: fmt(globals.totalBalance),
      sub: "sum of all balances",
      color: "var(--gold)",
    },
    {
      label: "Total Bets",
      value: fmt(globals.totalLost),
      sub: "FC wagered",
      color: "var(--red)",
    },
    {
      label: "Total Paid Out",
      value: fmt(globals.totalWon),
      sub: "FC won by users",
      color: "var(--accent)",
    },
    {
      label: "Games Played",
      value: fmt(globals.totalGames),
      sub: "all time",
      color: "var(--blue)",
    },
    {
      label: "Servers",
      value: fmt(guilds.length),
      sub: "bot is in",
      color: "var(--purple)",
    },
    {
      label: "Cmd Invocations",
      value: fmt(totalCmds),
      sub: "all-time",
      color: "var(--orange)",
    },
    {
      label: "Unique Cmds",
      value: fmt(commands.length),
      sub: "distinct commands",
      color: "var(--teal)",
    },
  ];
  const kpiHtml = kpis
    .map(
      (k) => `
    <div class="kpi" style="--kc:${k.color}">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value" style="color:${k.color}">${esc(k.value)}</div>
      <div class="kpi-sub">${esc(k.sub)}</div>
    </div>`,
    )
    .join("");

  const sortedDaily = [...daily].sort((a, b) => (a._id < b._id ? -1 : 1));
  const last7 = sortedDaily.slice(-7);
  const periodTotal = sortedDaily.reduce((s, d) => s + (d.total ?? 0), 0);
  const periodAvg = sortedDaily.length
    ? Math.round(periodTotal / sortedDaily.length)
    : 0;

  function chart(rows, height) {
    const max = Math.max(...rows.map((d) => d.total ?? 0), 1);
    const bars = rows
      .map((d) => {
        const p = pct(d.total, max);
        const lbl = String(d._id ?? "").slice(5); // MM-DD
        return `<div class="bar-col" title="${esc(d._id)}: ${fmt(d.total)} cmds">
        <div class="bar-col-bar" style="height:${p}%"></div>
        <div class="bar-col-lbl">${esc(lbl)}</div>
      </div>`;
      })
      .join("");
    return `<div class="bar-chart" style="height:${height}px">${bars || '<p class="empty" style="width:100%">No activity recorded yet.</p>'}</div>`;
  }

  const miniChartHtml = `<div class="chart-wrap">
    <div class="section-title" style="margin-bottom:.3rem">Last 7 Days</div>
    ${chart(last7, 70)}
    <button data-goto="activity" style="margin-top:.7rem;font-size:.66rem;color:var(--gold);font-weight:700">See full activity →</button>
  </div>`;

  const fullChartHtml = `<div class="chart-wrap">${chart(sortedDaily, 150)}</div>`;

  // ── Servers ──────────────────────────────────────────────────────────────
  const guildHtml = guilds.length
    ? guilds
        .map((g) => {
          const fr = freshness(g.lastSeen);
          return `<div class="guild-card" style="--fc:${fr.tone}">
          <div class="guild-name">${esc(g.name ?? g._id)}</div>
          <div class="guild-id">${esc(g._id)}</div>
          <div class="guild-meta">
            <span class="guild-tag">👥 ${fmt(g.memberCount ?? "?")}</span>
            <span class="guild-tag">🕐 ${esc(timeAgo(g.lastSeen))}</span>
            ${g.joinedAt ? `<span class="guild-tag">📅 joined ${esc(new Date(g.joinedAt).toLocaleDateString())}</span>` : ""}
          </div>
          <div class="guild-fresh" style="--fc:${fr.tone}">● ${esc(fr.label)}</div>
        </div>`;
        })
        .join("")
    : `<div class="empty">No guild data yet — upsertGuild() will populate this once the bot sees activity.</div>`;

  // ── Commands ─────────────────────────────────────────────────────────────
  const cmdMax = Math.max(...commands.map((c) => c.count ?? 0), 1);
  const cmdHtml = commands.length
    ? commands
        .map(
          (c) => `
      <div class="cmd-card">
        <div class="cmd-top">
          <span class="cmd-name">${esc(prefix ?? "&")}${esc(String(c._id).replace(/^cmd:/, ""))}</span>
          <span class="cmd-count">${fmt(c.count)}</span>
        </div>
        <div class="cmd-bar"><div class="cmd-bar-inner" style="width:${pct(c.count, cmdMax)}%"></div></div>
      </div>`,
        )
        .join("")
    : `<div class="empty">No command data yet — CommandHandler.recordCommand() will populate this.</div>`;

  // ── Top users ────────────────────────────────────────────────────────────
  const maxBal = Math.max(...topUsers.map((u) => u.bal ?? 0), 1);
  const medals = ["🥇", "🥈", "🥉"];
  const userRows = topUsers.length
    ? topUsers
        .map((u, i) => {
          const p = pct(u.bal, maxBal);
          return `<tr>
      <td class="rank ${i < 3 ? "medal" : ""}">${medals[i] ?? `#${i + 1}`}</td>
      <td class="uid">${esc(u._id)}</td>
      <td class="bal-val">${fmt(u.bal)}</td>
      <td><span class="bar-wrap"><span class="bar-inner" style="width:${p}%"></span></span></td>
      <td style="color:var(--text-dim)">${fmt(u.gp)}</td>
      <td style="color:#e07070">${fmt(u.tl)}</td>
      <td style="color:#70e090">${fmt(u.tw)}</td>
    </tr>`;
        })
        .join("")
    : "";
  const usersTableHtml = topUsers.length
    ? `<div class="tbl-wrap"><table>
        <thead><tr><th>#</th><th>User ID</th><th>Balance (FC)</th><th>Share</th><th>Games</th><th>Lost</th><th>Won</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table></div>`
    : `<div class="empty">No players yet.</div>`;

  // ── Page bodies ──────────────────────────────────────────────────────────
  const pageOverview = `
    ${pageHeader({
      eyebrow: "Overview",
      title: "Casino Vitals",
      color: "var(--accent)",
      sub: `${fmt(globals.totalUsers)} players · ${fmt(guilds.length)} servers · refreshed ${esc(refreshedAt)}`,
    })}
    <div class="kpi-grid">${kpiHtml}</div>
    ${miniChartHtml}`;

  const pageServers = `
    ${pageHeader({
      eyebrow: "Servers",
      title: "Servers",
      color: "var(--purple)",
      sub: `${fmt(guilds.length)} servers currently running the bot`,
    })}
    <div class="guild-grid">${guildHtml}</div>`;

  const pageCommands = `
    ${pageHeader({
      eyebrow: "Commands",
      title: "Command Usage",
      color: "var(--orange)",
      sub: `${fmt(commands.length)} distinct commands · ${fmt(totalCmds)} invocations all-time`,
    })}
    <div class="cmd-grid">${cmdHtml}</div>`;

  const pageUsers = `
    ${pageHeader({
      eyebrow: "Users",
      title: "Top Players",
      color: "var(--blue)",
      sub: `Top ${fmt(topUsers.length)} balances across all players`,
    })}
    ${usersTableHtml}`;

  const pageActivity = `
    ${pageHeader({
      eyebrow: "Activity",
      title: "Command Activity",
      color: "var(--gold)",
      sub: `${fmt(sortedDaily.length)} days of data, newest on the right`,
    })}
    <div class="stat-row">
      <div class="stat-pill"><b>${fmt(periodTotal)}</b>commands in period</div>
      <div class="stat-pill"><b>${fmt(periodAvg)}</b>daily average</div>
    </div>
    ${fullChartHtml}`;

  // ── Case Tiers management ──────────────────────────────────────────────────
  const pageCases = `
    ${pageHeader({
      eyebrow: "Case Tiers",
      title: "Case Battle Tiers",
      color: "var(--teal)",
      sub: "Manage built-in and custom case tiers",
    })}
    <div style="margin-bottom:1rem;display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn" style="background:var(--accent);color:#070f0a;padding:.45rem 1rem;border-radius:6px;font-weight:700;font-size:.78rem" onclick="adminAddCase()">+ Add custom tier</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>ID</th><th>Label</th><th>Entry</th><th>Items</th><th>RTP</th><th>Type</th><th>Actions</th></tr></thead>
        <tbody id="caseTableBody"><tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:2rem">Loading…</td></tr></tbody>
      </table>
    </div>
    <div style="margin-top:1.5rem;padding:1rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:.78rem;font-weight:700;color:var(--accent);margin-bottom:.5rem">Add / Edit Tier</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;font-size:.72rem">
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.2rem">ID (unique)</label><input id="ct-id" style="width:100%;font-size:.72rem" placeholder="mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.2rem">Label</label><input id="ct-label" style="width:100%;font-size:.72rem" placeholder="Mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.2rem">Entry cost (FC)</label><input id="ct-entry" type="number" style="width:100%;font-size:.72rem" placeholder="1000"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.2rem">Color</label><input id="ct-color" style="width:100%;font-size:.72rem" placeholder="#2ecc71"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.2rem">Background</label><input id="ct-bg" style="width:100%;font-size:.72rem" placeholder="#0a1f0a"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" style="background:var(--accent);color:#070f0a;padding:.4rem .8rem;border-radius:6px;font-weight:700;font-size:.72rem" onclick="adminSaveCase()">Save tier</button></div>
      </div>
      <div style="margin-top:.5rem;font-size:.65rem;color:var(--text-dim)">Items JSON (array of {s, n, v, w}):</div>
      <textarea id="ct-items" style="width:100%;height:80px;font-size:.65rem;font-family:var(--font-mono);background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:.4rem;margin-top:.3rem;resize:vertical" placeholder='[{"s":"💎","n":"Diamond","v":2000,"w":28}]'></textarea>
    </div>`;

  // ── Balances management ────────────────────────────────────────────────────
  const pageBalances = `
    ${pageHeader({
      eyebrow: "Balances",
      title: "User Balance Management",
      color: "var(--red)",
      sub: "Search for users and modify their FC balance",
    })}
    <div style="margin-bottom:1rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <input id="bal-search" style="font-size:.78rem;padding:.45rem .7rem;border-radius:6px;background:var(--bg);border:1px solid var(--border);color:var(--text);width:260px" placeholder="Search by user ID or min balance…">
      <button class="btn" style="background:var(--accent);color:#070f0a;padding:.4rem .9rem;border-radius:6px;font-weight:700;font-size:.78rem" onclick="adminSearchUsers()">Search</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>User ID</th><th>Balance</th><th>Won</th><th>Lost</th><th>Games</th><th>Actions</th></tr></thead>
        <tbody id="balTableBody"><tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:2rem">Search to find users</td></tr></tbody>
      </table>
    </div>`;

  // ── Active Battles management ──────────────────────────────────────────────
  const pageBattles = `
    ${pageHeader({
      eyebrow: "Battles",
      title: "Active Case Battles",
      color: "var(--orange)",
      sub: "View and manage ongoing battles",
    })}
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>ID</th><th>Mode</th><th>Phase</th><th>Cost</th><th>Pot</th><th>Players</th><th>Speed</th><th>Flags</th><th>Actions</th></tr></thead>
        <tbody id="battleTableBody"><tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:2rem">Loading…</td></tr></tbody>
      </table>
    </div>`;

  const pageBodies = {
    overview: pageOverview,
    servers: pageServers,
    commands: pageCommands,
    users: pageUsers,
    activity: pageActivity,
    cases: pageCases,
    balances: pageBalances,
    battles: pageBattles,
  };

  const navHtml = PAGES.map(
    (p, i) => `
    <button class="nav-item${i === 0 ? " active" : ""}" data-page="${p.id}" role="tab" aria-selected="${i === 0}">
      <span class="chip" style="--cc:${p.color}"></span> ${esc(p.label)}
    </button>`,
  ).join("");

  const pagesHtml = PAGES.map(
    (p, i) => `
    <section class="page${i === 0 ? " page-active" : ""}" data-page="${p.id}" role="tabpanel">
      ${pageBodies[p.id]}
    </section>`,
  ).join("");

  const script = `<script>
(function(){
  var navButtons = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-page]'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page[data-page]'));
  function show(id){
    pages.forEach(function(p){ p.classList.toggle('page-active', p.dataset.page === id); });
    navButtons.forEach(function(b){
      var active = b.dataset.page === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    try { history.replaceState(null, '', '#' + id); } catch(e) {}
  }
  navButtons.forEach(function(b){ b.addEventListener('click', function(){ show(b.dataset.page); }); });
  document.querySelectorAll('[data-goto]').forEach(function(el){
    el.addEventListener('click', function(){ show(el.dataset.goto); });
  });
  var ids = navButtons.map(function(b){ return b.dataset.page; });
  var initial = (location.hash || '').replace('#', '');
  show(ids.indexOf(initial) !== -1 ? initial : 'overview');

  // ── Admin JS: Case tiers ──
  function adminLoadCases(){
    fetch('/api/admin/cases').then(function(r){return r.json()}).then(function(d){
      var tiers=d.tiers||[];
      var tbody=document.getElementById('caseTableBody');
      if(!tbody)return;
      if(!tiers.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:1rem">No tiers found</td></tr>';return;}
      tbody.innerHTML=tiers.map(function(t){
        var avg=Math.round(t.items.reduce(function(s,i){return s+i.v*i.w},0)/t.items.reduce(function(s,i){return s+i.w},0));
        var rtp=Math.round(avg/t.entry*100);
        return '<tr>'+
          '<td style="font-family:var(--font-mono);font-size:.68rem;color:var(--text)">'+esc(t.id)+'</td>'+
          '<td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+esc(t.color||'#2ecc71')+';margin-right:.4rem;vertical-align:middle"></span>'+esc(t.label)+'</td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(t.entry)+'</td>'+
          '<td>'+t.items.length+' items</td>'+
          '<td>'+rtp+'%</td>'+
          '<td>'+(t.builtIn?'<span style="color:var(--accent);font-weight:700;font-size:.68rem">Built-in</span>':'<span style="color:var(--gold);font-weight:700;font-size:.68rem">Custom</span>')+'</td>'+
          '<td>'+(t.builtIn?'&mdash;':'<button onclick="adminDeleteCase(\''+esc(t.id)+'\')" style="color:var(--red);font-weight:700;font-size:.68rem;cursor:pointer;background:none;border:none;padding:.2rem .4rem;border-radius:4px">Delete</button>')+'</td>'+
        '</tr>';
      }).join('');
    }).catch(function(e){console.error(e)});
  }
  function adminAddCase(){
    document.getElementById('ct-id').value='';
    document.getElementById('ct-label').value='';
    document.getElementById('ct-entry').value='';
    document.getElementById('ct-color').value='#2ecc71';
    document.getElementById('ct-bg').value='#0a1f0a';
    document.getElementById('ct-items').value='';
    document.getElementById('ct-id').focus();
  }
  function adminSaveCase(){
    var id=document.getElementById('ct-id').value.trim();
    var label=document.getElementById('ct-label').value.trim();
    var entry=parseInt(document.getElementById('ct-entry').value)||0;
    var color=document.getElementById('ct-color').value.trim()||'#2ecc71';
    var bg=document.getElementById('ct-bg').value.trim()||'#0a1f0a';
    var itemsStr=document.getElementById('ct-items').value.trim();
    if(!id||!label||!entry){alert('ID, label, and entry cost are required.');return;}
    var items;try{items=JSON.parse(itemsStr);}catch(e){alert('Items must be valid JSON.');return;}
    if(!Array.isArray(items)||!items.length){alert('At least one item is required.');return;}
    fetch('/api/admin/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,label:label,entry:entry,color:color,bg:bg,items:items})})
      .then(function(r){return r.json()}).then(function(d){
        if(d.error)alert(d.error);else{alert('Tier saved!');adminLoadCases();}
      }).catch(function(e){alert('Error: '+e.message)});
  }
  function adminDeleteCase(id){
    if(!confirm('Delete tier "'+id+'"? This cannot be undone.'))return;
    fetch('/api/admin/cases/'+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(d){
      if(d.error)alert(d.error);else{alert('Tier deleted.');adminLoadCases();}
    }).catch(function(e){alert('Error: '+e.message)});
  }

  // ── Admin JS: User balances ──
  function adminSearchUsers(){
    var search=document.getElementById('bal-search').value.trim();
    fetch('/api/admin/users?search='+encodeURIComponent(search)+'&limit=30').then(function(r){return r.json()}).then(function(d){
      var users=d.users||[];
      var tbody=document.getElementById('balTableBody');
      if(!tbody)return;
      if(!users.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:1rem">No users found</td></tr>';return;}
      tbody.innerHTML=users.map(function(u){
        return '<tr>'+
          '<td style="font-family:var(--font-mono);font-size:.68rem">'+esc(u._id)+'</td>'+
          '<td style="font-family:var(--font-mono);color:var(--accent);font-weight:700">'+fmt(u.bal)+' FC</td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(u.tw)+'</td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(u.tl)+'</td>'+
          '<td>'+fmt(u.gp)+'</td>'+
          '<td><button onclick="adminShowBalModal(\''+esc(u._id)+'\','+u.bal+')" style="color:var(--accent);font-weight:700;font-size:.68rem;cursor:pointer;background:none;border:none;padding:.2rem .4rem;border-radius:4px">Edit balance</button></td>'+
        '</tr>';
      }).join('');
    }).catch(function(e){console.error(e)});
  }
  function adminShowBalModal(uid,currentBal){
    var newBal=prompt('Set balance for '+uid+'\\nCurrent: '+currentBal+' FC\\nEnter new balance or delta (+100, -50):');
    if(newBal===null)return;
    var num=Number(newBal);
    var delta;
    if(newBal.startsWith('+')||newBal.startsWith('-')){delta=Number(newBal);}
    else{delta=num-currentBal;}
    if(isNaN(delta)){alert('Invalid number.');return;}
    fetch('/api/admin/users/'+uid+'/balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delta:delta})})
      .then(function(r){return r.json()}).then(function(d){
        alert('Balance updated to '+d.bal+' FC');adminSearchUsers();
      }).catch(function(e){alert('Error: '+e.message)});
  }

  // ── Admin JS: Active battles ──
  function adminLoadBattles(){
    fetch('/api/admin/battles').then(function(r){return r.json()}).then(function(d){
      var battles=d.battles||[];
      var tbody=document.getElementById('battleTableBody');
      if(!tbody)return;
      if(!battles.length){tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:1rem">No active battles</td></tr>';return;}
      tbody.innerHTML=battles.map(function(b){
        var flags=[];
        if(b.speed==='fast')flags.push('Fast');
        if(b.jackpot)flags.push('Jackpot');
        if(b.crazy)flags.push('Crazy');
        return '<tr>'+
          '<td style="font-family:var(--font-mono);font-size:.65rem">'+esc(b.id.slice(0,12))+'&hellip;</td>'+
          '<td>'+esc(b.mode)+'</td>'+
          '<td><span style="color:'+(b.phase==='pending'?'var(--gold)':'var(--accent)')+';font-weight:700">'+esc(b.phase)+'</span></td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(b.cost)+'</td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(b.pot)+'</td>'+
          '<td>'+b.players.length+'/'+b.maxPlayers+'</td>'+
          '<td>'+esc(b.speed||'normal')+'</td>'+
          '<td>'+flags.join(', ')+'</td>'+
          '<td><button onclick="adminCancelBattle(\''+esc(b.id)+'\')" style="color:var(--red);font-weight:700;font-size:.68rem;cursor:pointer;background:none;border:none;padding:.2rem .4rem;border-radius:4px">Cancel</button></td>'+
        '</tr>';
      }).join('');
    }).catch(function(e){console.error(e)});
  }
  function adminCancelBattle(id){
    if(!confirm('Force-cancel this battle and refund all players?'))return;
    fetch('/api/admin/battles/'+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(d){
      if(d.error)alert(d.error);else{alert('Battle cancelled & refunded.');adminLoadBattles();}
    }).catch(function(e){alert('Error: '+e.message)});
  }

  // Auto-load data for visible pages
  var observer=new MutationObserver(function(){
    var active=document.querySelector('.page.page-active');
    if(!active)return;
    if(active.dataset.page==='cases')adminLoadCases();
    if(active.dataset.page==='battles')adminLoadBattles();
  });
  observer.observe(document.querySelector('.main'),{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  // Also run on hash change
  window.addEventListener('hashchange',function(){
    var page=(location.hash||'').replace('#','');
    if(page==='cases')adminLoadCases();
    if(page==='battles')adminLoadBattles();
  });
  // Initial load for default page
  if((location.hash||'').replace('#','')==='cases')adminLoadCases();
  if((location.hash||'').replace('#','')==='battles')adminLoadBattles();
})();
</script>`;

  return shell(
    `<div class="layout">
  <aside class="sidebar">
    <div class="logo">
      <span class="logo-icon">🎰</span>
      <div><div class="logo-text">SirGreen</div><div class="logo-sub">Admin Panel</div></div>
    </div>
    <span class="nav-section">Sections</span>
    ${navHtml}
    <div style="flex:1"></div>
    <div class="sidebar-foot">
      <a href="/logout">⏏ Logout</a>
      <span class="ts">Refreshed ${esc(refreshedAt)}</span>
    </div>
  </aside>
  <main class="main">${pagesHtml}</main>
</div>${script}`,
    "Admin Panel — SirGreen Casino",
  );
}

export class AdminPanel {
  /** @param {import('./Database.mjs').Database} db */
  constructor(db, prefix = "&") {
    this.db = db;
    this.prefix = prefix;
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
    return buildPage({
      globals,
      commands,
      guilds,
      daily,
      topUsers,
      buildAt: Date.now(),
    }, this.prefix);
  }

  /** Convenience: return the login-required page. */
  loginRequired(loginUrl) {
    return loginRequiredPage(loginUrl);
  }

  /** Convenience: return the access-denied page for a logged-in non-admin. */
  accessDenied(uid) {
    return deniedPage(uid);
  }
}
