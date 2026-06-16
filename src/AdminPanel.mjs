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
  if (!ms) return { tone: "var(--border)", label: "no activity" };
  const sec = (Date.now() - ms) / 1000;
  if (sec < 3600) return { tone: "var(--accent)", label: "active now" };
  if (sec < 86400) return { tone: "var(--gold)", label: "active today" };
  return { tone: "var(--border)", label: "quiet" };
}

// ── Page registry — drives both the sidebar nav and the page sections ──────
// Each entry's colour becomes that section's identity throughout the UI.
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
  --bg:#09090b;
  --surface:#111113;
  --surface-2:#18181b;
  --surface-3:#1f1f23;
  --border:#27272a;
  --border-soft:#1f1f23;
  --text-bright:#fafafa;
  --text:#a1a1aa;
  --text-dim:#52525b;
  --text-faint:#3f3f46;
  --accent:#22c55e;
  --accent-hover:#16a34a;
  --gold:#eab308;
  --purple:#a855f7;
  --blue:#3b82f6;
  --orange:#f97316;
  --red:#ef4444;
  --teal:#14b8a6;

  --r-sm:8px;
  --r-md:12px;
  --r-lg:16px;

  --shadow-sm:0 1px 2px 0 rgb(0 0 0 / 0.4);
  --shadow-md:0 2px 6px -1px rgb(0 0 0 / 0.5), 0 1px 3px -1px rgb(0 0 0 / 0.4);

  --font-body:'Inter',system-ui,-apple-system,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-size:14px}
body{background:var(--bg);color:var(--text);font-family:var(--font-body);min-height:100vh;font-feature-settings:"cv11","ss01"}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
input,textarea,select{font:inherit;color:inherit}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:var(--text-dim)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}

/* ── Layout ───────────────────────────────────────────────────────────── */
.layout{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.sidebar{background:var(--bg);border-right:1px solid var(--border);padding:1.25rem 0.85rem;display:flex;flex-direction:column;gap:.15rem;position:sticky;top:0;height:100vh;overflow-y:auto}
.logo{display:flex;align-items:center;gap:.6rem;padding:.4rem .5rem 1.1rem;border-bottom:1px solid var(--border);margin-bottom:.6rem}
.logo-icon{font-size:1.4rem;line-height:1}
.logo-text{font-family:var(--font-body);font-size:.95rem;font-weight:700;color:var(--text-bright);letter-spacing:-.01em}
.logo-sub{font-size:.6rem;color:var(--text-dim);letter-spacing:.1em;text-transform:uppercase;margin-top:.1rem;font-weight:500}

/* ── Sidebar nav — text-only with a left accent bar on active ─────────── */
.nav-item{
  position:relative;
  display:flex;
  align-items:center;
  padding:.5rem .7rem .5rem .9rem;
  border-radius:var(--r-sm);
  font-size:.82rem;
  font-weight:500;
  color:var(--text);
  width:100%;
  text-align:left;
  transition:background 150ms ease,color 150ms ease;
}
.nav-item::before{
  content:"";
  position:absolute;
  left:0;top:6px;bottom:6px;
  width:2px;
  border-radius:0 2px 2px 0;
  background:transparent;
  transition:background 150ms ease;
}
.nav-item:hover{background:var(--surface);color:var(--text-bright)}
.nav-item.active{background:var(--surface);color:var(--text-bright;font-weight:600}
.nav-item.active::before{background:var(--pc,var(--accent))}
.nav-section{font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim);padding:.7rem .9rem .35rem;font-weight:600}
.sidebar-foot{display:flex;flex-direction:column;gap:.1rem;padding:.6rem .9rem 0;margin-top:.5rem;border-top:1px solid var(--border)}
.sidebar-foot a{font-size:.72rem;color:var(--text-dim);padding:.25rem 0;transition:color 150ms ease}
.sidebar-foot a:hover{color:var(--red)}
.sidebar-foot .ts{font-size:.62rem;color:var(--text-dim);font-family:var(--font-mono);margin-top:.1rem}

.main{padding:1.85rem 2.25rem;overflow-x:hidden;max-width:100%}

/* ── Pages — only the active one renders ──────────────────────────────── */
.page{display:none}
.page.page-active{display:block;animation:fadeIn 180ms ease both}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

/* ── Page header ──────────────────────────────────────────────────────── */
.page-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.6rem;gap:1rem;padding-bottom:1.1rem;border-bottom:1px solid var(--border)}
.page-eyebrow{font-size:.65rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--pc,var(--accent));margin-bottom:.4rem}
.page-title{font-family:var(--font-body);font-size:1.5rem;font-weight:700;color:var(--text-bright);letter-spacing:-.02em;line-height:1.1}
.page-sub{font-size:.78rem;color:var(--text-dim);margin-top:.4rem}
.badge{display:inline-flex;align-items:center;gap:.4rem;background:var(--surface);border:1px solid var(--border);border-radius:99px;padding:.25rem .65rem;font-size:.65rem;font-weight:500;color:var(--text);white-space:nowrap}
.badge-dot{width:6px;height:6px;background:var(--accent);border-radius:50%}

/* ── KPI cards ────────────────────────────────────────────────────────── */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.75rem;margin-bottom:1.75rem}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:1rem 1.1rem;box-shadow:var(--shadow-sm);transition:border-color 150ms ease,transform 150ms ease}
.kpi:hover{border-color:var(--text-dim)}
.kpi-label{font-size:.65rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);margin-bottom:.5rem}
.kpi-value{font-family:var(--font-body);font-size:1.6rem;font-weight:700;color:var(--text-bright);letter-spacing:-.025em;line-height:1}
.kpi-sub{font-size:.65rem;color:var(--text-dim);margin-top:.4rem}

/* ── Section ──────────────────────────────────────────────────────────── */
.section{margin-bottom:1.9rem}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem}
.section-title{font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-bright);display:flex;align-items:center;gap:.5rem}
.section-title::before{content:"";display:block;width:3px;height:13px;background:var(--accent);border-radius:2px}
.stat-row{display:flex;gap:.6rem;margin-bottom:1.2rem;flex-wrap:wrap}
.stat-pill{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:.55rem .9rem;font-size:.72rem;color:var(--text-dim)}
.stat-pill b{font-family:var(--font-mono);color:var(--text-bright);font-size:.85rem;margin-right:.35rem;font-weight:600}

/* ── Table ────────────────────────────────────────────────────────────── */
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;box-shadow:var(--shadow-sm)}
table{width:100%;border-collapse:collapse}
thead tr{background:var(--surface-2)}
th{padding:.65rem .9rem;font-size:.65rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.6rem .9rem;font-size:.78rem;color:var(--text);border-bottom:1px solid var(--border);white-space:nowrap;transition:background 150ms ease}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--surface-2)}
.rank{font-weight:600;color:var(--text-dim);width:36px;font-family:var(--font-mono)}
.rank.medal{font-size:.95rem}
.uid{font-family:var(--font-mono);font-size:.7rem;color:var(--text-dim)}
.bal-val{font-weight:600;color:var(--accent);font-family:var(--font-mono)}
.bar-wrap{width:120px;background:var(--surface-3);border-radius:99px;height:5px;display:inline-block;vertical-align:middle;overflow:hidden}
.bar-inner{height:100%;background:var(--accent);border-radius:99px;min-width:2px;transition:width 300ms ease}

/* ── Command cards ────────────────────────────────────────────────────── */
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.65rem}
.cmd-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:.75rem .95rem;display:flex;flex-direction:column;gap:.55rem;transition:border-color 150ms ease}
.cmd-card:hover{border-color:var(--text-dim)}
.cmd-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.cmd-name{font-size:.78rem;font-weight:600;color:var(--text-bright);font-family:var(--font-mono)}
.cmd-count{font-family:var(--font-body);font-size:1rem;font-weight:700;color:var(--orange)}
.cmd-bar{width:100%;background:var(--surface-3);border-radius:99px;height:4px;overflow:hidden}
.cmd-bar-inner{height:100%;background:var(--orange);border-radius:99px;min-width:2px;transition:width 300ms ease}

/* ── Guild cards ──────────────────────────────────────────────────────── */
.guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.75rem}
.guild-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--fc,var(--border));border-radius:var(--r-sm);padding:.85rem 1rem;transition:border-color 150ms ease}
.guild-card:hover{border-color:var(--text-dim)}
.guild-name{font-size:.85rem;font-weight:600;color:var(--text-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.guild-id{font-size:.65rem;color:var(--text-dim);font-family:var(--font-mono);margin-top:.2rem}
.guild-meta{display:flex;gap:.4rem;margin-top:.65rem;flex-wrap:wrap}
.guild-tag{font-size:.65rem;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:.15rem .5rem;border-radius:6px;font-weight:500}
.guild-fresh{font-size:.65rem;font-weight:500;margin-top:.55rem;color:var(--fc,var(--text-dim))}

/* ── Bar chart ────────────────────────────────────────────────────────── */
.chart-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:1.2rem 1.4rem;box-shadow:var(--shadow-sm)}
.bar-chart{display:flex;align-items:flex-end;gap:6px;height:140px;margin-top:.85rem;padding-top:1rem}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;min-width:0;height:100%;justify-content:flex-end}
.bar-col-bar{width:100%;background:var(--gold);border-radius:4px 4px 0 0;min-height:3px;transition:opacity 150ms ease,transform 150ms ease;cursor:default}
.bar-col-bar:hover{opacity:.7}
.bar-col-lbl{font-size:.6rem;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38px;text-align:center;font-family:var(--font-mono)}

/* ── Empty state ──────────────────────────────────────────────────────── */
.empty{color:var(--text-dim);font-size:.8rem;background:var(--surface);border:1px dashed var(--border);border-radius:var(--r-sm);padding:1.4rem;text-align:center}

/* ── Forms (used inside management pages) ─────────────────────────────── */
.input{
  width:100%;
  font-size:.78rem;
  padding:.5rem .7rem;
  border-radius:var(--r-sm);
  background:var(--bg);
  border:1px solid var(--border);
  color:var(--text);
  transition:border-color 150ms ease;
}
.input:focus{border-color:var(--accent);outline:none}
.btn{
  display:inline-flex;
  align-items:center;
  gap:.4rem;
  padding:.45rem .95rem;
  border-radius:var(--r-sm);
  font-weight:600;
  font-size:.78rem;
  border:1px solid transparent;
  transition:background 150ms ease,border-color 150ms ease,color 150ms ease;
}
.btn-primary{background:var(--accent);color:#052e16}
.btn-primary:hover{background:var(--accent-hover)}
.btn-ghost{background:var(--surface);color:var(--text);border-color:var(--border)}
.btn-ghost:hover{background:var(--surface-2);color:var(--text-bright);border-color:var(--text-dim)}
.btn-danger{color:var(--red);background:none;font-weight:600;font-size:.7rem;padding:.25rem .5rem;border-radius:6px}
.btn-danger:hover{background:var(--surface)}

/* ── Access denied / login ───────────────────────────────────────────── */
.denied{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--font-body);padding:1rem}
.denied-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:2.5rem 2rem;max-width:400px;text-align:center;box-shadow:var(--shadow-md)}
.denied-icon{font-size:2.5rem;margin-bottom:.75rem}
.denied-title{font-family:var(--font-body);font-size:1.25rem;font-weight:700;color:var(--text-bright);margin-bottom:.5rem;letter-spacing:-.01em}
.denied-msg{font-size:.82rem;color:var(--text);line-height:1.6;margin-bottom:1.25rem}
.denied-id{font-family:var(--font-mono);font-size:.7rem;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:.3rem .7rem;border-radius:var(--r-sm);display:inline-block}

/* ── Responsive ───────────────────────────────────────────────────────── */
@media(max-width:780px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}
  .main{padding:1.1rem}
}
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
    <a href="${esc(loginUrl)}" class="btn btn-primary" style="margin-top:.3rem">🔑 Login with Fluxer</a>
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
    <button data-goto="activity" style="margin-top:.85rem;font-size:.72rem;color:var(--gold);font-weight:600;background:none;border:none;padding:0;cursor:pointer">See full activity →</button>
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
      <td style="color:var(--red)">${fmt(u.tl)}</td>
      <td style="color:var(--accent)">${fmt(u.tw)}</td>
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
      <button class="btn btn-primary" onclick="adminAddCase()">+ Add custom tier</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>ID</th><th>Label</th><th>Entry</th><th>Items</th><th>RTP</th><th>Type</th><th>Actions</th></tr></thead>
        <tbody id="caseTableBody"><tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:2rem">Loading…</td></tr></tbody>
      </table>
    </div>
    <div style="margin-top:1.5rem;padding:1.1rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">
      <div style="font-size:.8rem;font-weight:600;color:var(--text-bright);margin-bottom:.7rem">Add / Edit Tier</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem;font-size:.74rem">
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">ID (unique)</label><input id="ct-id" class="input" placeholder="mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Label</label><input id="ct-label" class="input" placeholder="Mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Entry cost (FC)</label><input id="ct-entry" type="number" class="input" placeholder="1000"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Color</label><input id="ct-color" class="input" placeholder="#22c55e"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Background</label><input id="ct-bg" class="input" placeholder="#0a1f0a"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn btn-primary" onclick="adminSaveCase()">Save tier</button></div>
      </div>
      <div style="margin-top:.7rem;font-size:.7rem;color:var(--text-dim)">Items JSON (array of {s, n, v, w}):</div>
      <textarea id="ct-items" class="input" style="height:90px;font-size:.68rem;font-family:var(--font-mono);margin-top:.35rem;resize:vertical" placeholder='[{"s":"💎","n":"Diamond","v":2000,"w":28}]'></textarea>
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
      <input id="bal-search" class="input" style="width:280px" placeholder="Search by user ID or min balance…">
      <button class="btn btn-primary" onclick="adminSearchUsers()">Search</button>
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
    <button class="nav-item${i === 0 ? " active" : ""}" data-page="${p.id}" style="--pc:${p.color}" role="tab" aria-selected="${i === 0}">
      ${esc(p.label)}
    </button>`,
  ).join("");

  const pagesHtml = PAGES.map(
    (p, i) => `
    <section class="page${i === 0 ? " page-active" : ""}" data-page="${p.id}" role="tabpanel" id="page-${p.id}">
      ${pageBodies[p.id]}
    </section>`,
  ).join("");

  const script = `<script>
(function(){
  // ── Tab switching ────────────────────────────────────────────────────────
  var navButtons = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-page]'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page[data-page]'));
  var validIds = ['overview','servers','commands','users','activity','cases','balances','battles'];

  function show(id){
    if (validIds.indexOf(id) === -1) id = 'overview';
    pages.forEach(function(p){
      var active = p.dataset.page === id;
      p.classList.toggle('page-active', active);
    });
    navButtons.forEach(function(b){
      var active = b.dataset.page === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    try { history.replaceState(null, '', '#' + id); } catch(e) {}
    // Fire loaders for tabs that need fresh data on activation.
    if (id === 'cases')   { try { window.adminLoadCases();   } catch(e) { console.error(e); } }
    if (id === 'battles') { try { window.adminLoadBattles(); } catch(e) { console.error(e); } }
  }

  navButtons.forEach(function(b){
    b.addEventListener('click', function(ev){
      ev.preventDefault();
      show(b.dataset.page);
    });
  });

  document.querySelectorAll('[data-goto]').forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.preventDefault();
      show(el.dataset.goto);
    });
  });

  var initial = (location.hash || '').replace('#', '');
  show(validIds.indexOf(initial) !== -1 ? initial : 'overview');

  window.addEventListener('hashchange', function(){
    var page = (location.hash || '').replace('#', '');
    if (validIds.indexOf(page) !== -1) show(page);
  });

  // ── Expose admin functions on window so inline onclick="" handlers work ─
  // (Inline handlers in the rendered HTML reference these by name.)

  window.adminLoadCases = function adminLoadCases(){
    fetch('/api/admin/cases').then(function(r){return r.json()}).then(function(d){
      var tiers = (d && d.tiers) || [];
      var tbody = document.getElementById('caseTableBody');
      if (!tbody) return;
      if (!tiers.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:1rem">No tiers found</td></tr>';
        return;
      }
      tbody.innerHTML = tiers.map(function(t){
        var totalW = t.items.reduce(function(s,i){ return s + (i.w || 0); }, 0);
        var totalV = t.items.reduce(function(s,i){ return s + ((i.v || 0) * (i.w || 0)); }, 0);
        var avg = totalW ? Math.round(totalV / totalW) : 0;
        var rtp = t.entry ? Math.round(avg / t.entry * 100) : 0;
        var typeCell = t.builtIn
          ? '<span style="color:var(--accent);font-weight:600;font-size:.7rem">Built-in</span>'
          : '<span style="color:var(--gold);font-weight:600;font-size:.7rem">Custom</span>';
        var actionCell = t.builtIn
          ? '<span style="color:var(--text-dim)">&mdash;</span>'
          : '<button class="btn-danger" onclick="adminDeleteCase(\\''+String(t.id).replace(/'/g,"\\\\'")+'\\')">Delete</button>';
        return '<tr>'+
          '<td style="font-family:var(--font-mono);font-size:.7rem;color:var(--text)">'+esc(t.id)+'</td>'+
          '<td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+esc(t.color||'#22c55e')+';margin-right:.5rem;vertical-align:middle"></span>'+esc(t.label)+'</td>'+
          '<td style="font-family:var(--font-mono)">'+fmt(t.entry)+'</td>'+
          '<td>'+t.items.length+' items</td>'+
          '<td>'+rtp+'%</td>'+
          '<td>'+typeCell+'</td>'+
          '<td>'+actionCell+'</td>'+
        '</tr>';
      }).join('');
    }).catch(function(e){ console.error('adminLoadCases', e); });
  };

  window.adminAddCase = function adminAddCase(){
    var idEl = document.getElementById('ct-id');
    if (!idEl) return;
    idEl.value = '';
    document.getElementById('ct-label').value = '';
    document.getElementById('ct-entry').value = '';
    document.getElementById('ct-color').value = '#22c55e';
    document.getElementById('ct-bg').value = '#0a1f0a';
    document.getElementById('ct-items').value = '';
    idEl.focus();
  };

  window.adminSaveCase = function adminSaveCase(){
    var id    = (document.getElementById('ct-id')    || {}).value || '';
    var label = (document.getElementById('ct-label') || {}).value || '';
    var entry = parseInt((document.getElementById('ct-entry') || {}).value) || 0;
    var color = ((document.getElementById('ct-color') || {}).value || '').trim() || '#22c55e';
    var bg    = ((document.getElementById('ct-bg')    || {}).value || '').trim() || '#0a1f0a';
    var itemsStr = ((document.getElementById('ct-items') || {}).value || '').trim();
    id = id.trim(); label = label.trim();
    if (!id || !label || !entry) { alert('ID, label, and entry cost are required.'); return; }
    var items;
    try { items = JSON.parse(itemsStr); }
    catch(e) { alert('Items must be valid JSON.'); return; }
    if (!Array.isArray(items) || !items.length) { alert('At least one item is required.'); return; }
    fetch('/api/admin/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id:id, label:label, entry:entry, color:color, bg:bg, items:items })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.error) { alert(d.error); return; }
        alert('Tier saved!');
        window.adminLoadCases();
      })
      .catch(function(e){ alert('Error: ' + e.message); });
  };

  window.adminDeleteCase = function adminDeleteCase(id){
    if (!confirm('Delete tier "'+id+'"? This cannot be undone.')) return;
    fetch('/api/admin/cases/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.error) { alert(d.error); return; }
        alert('Tier deleted.');
        window.adminLoadCases();
      })
      .catch(function(e){ alert('Error: ' + e.message); });
  };

  window.adminSearchUsers = function adminSearchUsers(){
    var searchEl = document.getElementById('bal-search');
    var search = searchEl ? searchEl.value.trim() : '';
    fetch('/api/admin/users?search=' + encodeURIComponent(search) + '&limit=30')
      .then(function(r){ return r.json(); })
      .then(function(d){
        var users = (d && d.users) || [];
        var tbody = document.getElementById('balTableBody');
        if (!tbody) return;
        if (!users.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:1rem">No users found</td></tr>';
          return;
        }
        tbody.innerHTML = users.map(function(u){
          var safeId = String(u._id).replace(/'/g, "\\\\'");
          return '<tr>'+
            '<td class="uid">'+esc(u._id)+'</td>'+
            '<td class="bal-val">'+fmt(u.bal)+' FC</td>'+
            '<td style="font-family:var(--font-mono)">'+fmt(u.tw)+'</td>'+
            '<td style="font-family:var(--font-mono)">'+fmt(u.tl)+'</td>'+
            '<td>'+fmt(u.gp)+'</td>'+
            '<td><button class="btn-danger" onclick="adminShowBalModal(\\''+safeId+'\\','+u.bal+')">Edit balance</button></td>'+
          '</tr>';
        }).join('');
      })
      .catch(function(e){ console.error('adminSearchUsers', e); });
  };

  window.adminShowBalModal = function adminShowBalModal(uid, currentBal){
    var newBal = prompt('Set balance for '+uid+'\\nCurrent: '+currentBal+' FC\\nEnter new balance or delta (+100, -50):');
    if (newBal === null) return;
    var delta;
    if (String(newBal).charAt(0) === '+' || String(newBal).charAt(0) === '-') {
      delta = Number(newBal);
    } else {
      delta = Number(newBal) - currentBal;
    }
    if (isNaN(delta)) { alert('Invalid number.'); return; }
    fetch('/api/admin/users/' + encodeURIComponent(uid) + '/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta: delta })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        alert('Balance updated to ' + d.bal + ' FC');
        window.adminSearchUsers();
      })
      .catch(function(e){ alert('Error: ' + e.message); });
  };

  window.adminLoadBattles = function adminLoadBattles(){
    fetch('/api/admin/battles')
      .then(function(r){ return r.json(); })
      .then(function(d){
        var battles = (d && d.battles) || [];
        var tbody = document.getElementById('battleTableBody');
        if (!tbody) return;
        if (!battles.length) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:1rem">No active battles</td></tr>';
          return;
        }
        tbody.innerHTML = battles.map(function(b){
          var flags = [];
          if (b.speed === 'fast')   flags.push('Fast');
          if (b.jackpot)            flags.push('Jackpot');
          if (b.crazy)              flags.push('Crazy');
          var phaseColor = b.phase === 'pending' ? 'var(--gold)' : 'var(--accent)';
          var safeId = String(b.id).replace(/'/g, "\\\\'");
          var shortId = String(b.id).slice(0, 12) + '…';
          return '<tr>'+
            '<td class="uid">'+esc(shortId)+'</td>'+
            '<td>'+esc(b.mode)+'</td>'+
            '<td><span style="color:'+phaseColor+';font-weight:600">'+esc(b.phase)+'</span></td>'+
            '<td style="font-family:var(--font-mono)">'+fmt(b.cost)+'</td>'+
            '<td style="font-family:var(--font-mono)">'+fmt(b.pot)+'</td>'+
            '<td>'+b.players.length+'/'+b.maxPlayers+'</td>'+
            '<td>'+esc(b.speed || 'normal')+'</td>'+
            '<td>'+esc(flags.join(', '))+'</td>'+
            '<td><button class="btn-danger" onclick="adminCancelBattle(\\''+safeId+'\\')">Cancel</button></td>'+
          '</tr>';
        }).join('');
      })
      .catch(function(e){ console.error('adminLoadBattles', e); });
  };

  window.adminCancelBattle = function adminCancelBattle(id){
    if (!confirm('Force-cancel this battle and refund all players?')) return;
    fetch('/api/admin/battles/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.error) { alert(d.error); return; }
        alert('Battle cancelled & refunded.');
        window.adminLoadBattles();
      })
      .catch(function(e){ alert('Error: ' + e.message); });
  };

  // Initial load if the page hash already points at a data-driven tab.
  var startHash = (location.hash || '').replace('#', '');
  if (startHash === 'cases')   { try { window.adminLoadCases();   } catch(e) {} }
  if (startHash === 'battles') { try { window.adminLoadBattles(); } catch(e) {} }
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
