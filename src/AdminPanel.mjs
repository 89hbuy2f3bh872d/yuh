/**
 * AdminPanel.mjs
 * Serves the /admin/panel dashboard.
 * Access is restricted to a single hardcoded Fluxer user ID.
 * Authentication re-uses the existing Fluxer OAuth session cookie (sid/uid)
 * that WebServer already sets — no separate login needed.
 */

// Hard owner — full access, always, can't be revoked.
const ADMIN_USER_ID = "1512241609448620032";
const OWNER_ID = ADMIN_USER_ID;

// Grantable permissions. Each maps to admin actions/tabs.
const PERMS = [
  { id: "balances", label: "Edit balances", desc: "Add or set any user's FC balance" },
  { id: "cases",    label: "Manage cases",  desc: "Create and delete case tiers" },
  { id: "battles",  label: "Manage battles", desc: "View and force-cancel battles" },
  { id: "users",    label: "Manage users",   desc: "Grant or revoke admin permissions" },
  { id: "tickets",  label: "Support tickets", desc: "View and reply to support tickets" },
  { id: "tax",      label: "Set server tax", desc: "Set a server's tax with no 15% floor or vote needed" },
  { id: "servers",  label: "Manage servers", desc: "View & edit every server's bank, tax and shop" },
];
const PERM_IDS = PERMS.map(p => p.id);

function isOwner(uid) { return String(uid ?? "") === OWNER_ID; }
function hasPerm(uid, perms, perm) {
  if (isOwner(uid)) return true;
  return Array.isArray(perms) && perms.includes(perm);
}
/** Which page ids a user may see, given uid + perms. */
function visiblePages(uid, perms) {
  if (isOwner(uid)) return PAGES.map(p => p.id);
  const out = [];
  for (const pg of PAGES) {
    if (pg.perm === "owner") continue;                 // stats: owner only
    if (pg.perm === "userlist") { if (hasPerm(uid, perms, "balances") || hasPerm(uid, perms, "users")) out.push(pg.id); }
    else if (hasPerm(uid, perms, pg.perm)) out.push(pg.id);
  }
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n) {
  return Math.round(Number(n ?? 0)).toLocaleString("en-US");
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
  { id: "overview", label: "Dashboard", color: "var(--accent)", perm: "owner" },
  { id: "servers", label: "Servers", color: "var(--purple)", perm: "owner" },
  { id: "commands", label: "Commands", color: "var(--orange)", perm: "owner" },
  { id: "users", label: "Top Users", color: "var(--blue)", perm: "owner" },
  { id: "activity", label: "Activity", color: "var(--gold)", perm: "owner" },
  { id: "cases", label: "Case Tiers", color: "var(--teal)", perm: "cases" },
  { id: "battles", label: "Battles", color: "var(--orange)", perm: "battles" },
  { id: "userlist", label: "User List", color: "var(--red)", perm: "userlist" },
  { id: "tickets", label: "Support", color: "var(--blue)", perm: "tickets" },
];

function shell(body, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/assets/css/admin.css?v=5"></head><body>${body}</body></html>`;
}

function deniedPage(uid) {
  return shell(
    `<div class="denied">
  <div class="denied-card">
    <div class="denied-icon">🔒</div>
    <div class="denied-title">Access Denied</div>
    <div class="denied-msg">This admin panel is restricted to authorised personnel only.<br>Your identity has been logged.</div>
    <div class="denied-id">${esc(uid ?? "not logged in")}</div>
    <a href="/" class="btn btn-ghost" style="margin-top:1rem">← Back to site</a>
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
    <a href="${esc(loginUrl)}" class="btn btn-primary" style="margin-top:.4rem">🔑 Login with Fluxer</a>
  </div>
</div>`,
    "Admin — Login",
  );
}

function pageHeader({ eyebrow, title, sub, color }) {
  return `<div class="page-header" style="--pc:${color}">
    <div class="ph-left">
      <div class="page-eyebrow">${esc(eyebrow)}</div>
      <div class="page-title">${esc(title)}</div>
      <div class="page-sub">${sub}</div>
    </div>
    <div class="badge"><span class="badge-dot"></span> Live</div>
  </div>`;
}

function buildPage(data, prefix) {
  const { globals, commands, guilds, daily, topUsers, buildAt } = data;
  const allowed = Array.isArray(data.allowed) ? data.allowed : PAGES.map(p => p.id);
  const owner = !!data.owner;
  const canBalances = owner || (Array.isArray(data.perms) && data.perms.includes("balances"));
  const canManageUsers = owner || (Array.isArray(data.perms) && data.perms.includes("users"));
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
      sub: globals.circulation
        ? `${fmt(globals.circulation.balances)} liquid · ${fmt(globals.circulation.banks)} banks · ${fmt(globals.circulation.invested)} invested`
        : "balances + banks + invested",
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
    ${miniChartHtml}
    ${data.owner ? `
    <div style="margin-top:1.6rem;border:1px solid var(--red);border-radius:var(--r-md);padding:1.1rem;background:rgba(239,68,68,.05)">
      <div style="font-size:.85rem;font-weight:800;color:var(--red);margin-bottom:.3rem">⚠ Danger Zone — Owner only</div>
      <div style="font-size:.74rem;color:var(--text-dim);margin-bottom:.8rem">Permanently erases <b>every</b> collection: balances, tickets, tiers, stats. This cannot be undone.</div>
      <button class="btn-danger" onclick="adminWipeDb()">Wipe entire database</button>
    </div>` : ""}`;

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
      <div style="font-size:.8rem;font-weight:600;color:var(--text-bright);margin-bottom:.7rem">Create a tier</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:.6rem;font-size:.74rem">
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">ID (unique)</label><input id="ct-id" class="input" placeholder="mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Label</label><input id="ct-label" class="input" placeholder="Mythic"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Entry cost (FC)</label><input id="ct-entry" type="number" class="input" placeholder="1000"></div>
        <div><label style="color:var(--text-dim);display:block;margin-bottom:.25rem;font-weight:500">Color</label><input id="ct-color" type="color" class="input" value="#22c55e" style="padding:.2rem;height:38px"></div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin:1rem 0 .5rem">
        <div style="font-size:.74rem;font-weight:600;color:var(--text-bright)">Items</div>
        <div style="font-size:.72rem;color:var(--text-dim)">Live RTP: <b id="ct-rtp" style="color:var(--accent)">—</b></div>
      </div>
      <div style="display:grid;grid-template-columns:60px 1fr 1fr 1fr 32px;gap:.5rem;font-size:.62rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding:0 .1rem .35rem">
        <div>Emoji</div><div>Name</div><div>Value (FC)</div><div>Weight</div><div></div>
      </div>
      <div id="ct-rows"></div>
      <button class="btn btn-secondary" onclick="adminAddItemRow()" style="margin-top:.5rem"><span style="font-size:1rem;line-height:1">+</span> Add item</button>

      <div style="margin-top:1.1rem;display:flex;gap:.5rem">
        <button class="btn btn-primary" id="ct-save-btn" onclick="adminSaveCase()">Save tier</button>
        <button class="btn btn-ghost" onclick="adminAddCase()">Clear</button>
      </div>
    </div>`;

  // ── User List (balances + admin permissions) ───────────────────────────────
  const permCols = PERMS.map(p => `<th title="${esc(p.desc)}">${esc(p.label.replace(/^(Edit|Manage) /, ""))}</th>`).join("");
  const pageUserList = `
    ${pageHeader({
      eyebrow: "Users",
      title: "User List",
      color: "var(--red)",
      sub: "Search users, edit balances, and manage admin permissions",
    })}
    <div style="margin-bottom:1rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <input id="ul-search" class="input" style="width:300px" placeholder="Search by username or ID…">
      <button class="btn btn-primary" onclick="adminSearchUsers()">Search</button>
      <button class="btn btn-secondary" onclick="adminLoadAdmins()">Show current admins</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>User</th><th>Balance</th>
          ${canManageUsers ? permCols : ""}
          <th>Actions</th>
        </tr></thead>
        <tbody id="ulTableBody"><tr><td colspan="${2 + (canManageUsers ? PERMS.length : 0) + 1}" style="text-align:center;color:var(--text-dim);padding:2rem">Search or show current admins</td></tr></tbody>
      </table>
    </div>
    <div style="margin-top:.8rem;font-size:.7rem;color:var(--text-dim)">
      ${canManageUsers ? "Toggle a permission to grant/revoke it instantly. The owner always has full access and cannot be changed." : "You can edit balances. Permission management requires the Manage Users permission."}
    </div>
    <script>window.__UL_CFG__={canBal:${canBalances},canPerms:${canManageUsers},owner:"${esc(OWNER_ID)}",perms:${JSON.stringify(PERM_IDS)},permLabels:${JSON.stringify(PERMS.map(p => p.label.replace(/^(Edit|Manage) /, "")))}};</script>`;

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

  const pageTickets = `
    ${pageHeader({ eyebrow: "Support", title: "Support Tickets", color: "var(--blue)", sub: "Reply to and close player tickets" })}
    <div class="tbl-wrap"><div id="tkAdminList"><div style="padding:1.4rem;text-align:center;color:var(--text-dim)">Loading…</div></div></div>`;

  const pageBodies = {
    overview: pageOverview,
    servers: pageServers,
    commands: pageCommands,
    users: pageUsers,
    activity: pageActivity,
    cases: pageCases,
    userlist: pageUserList,
    battles: pageBattles,
    tickets: pageTickets,
  };

  // Only render tabs/pages the viewer is allowed to see.
  const shownPages = PAGES.filter(p => allowed.includes(p.id));
  const firstId = shownPages.length ? shownPages[0].id : "";

  const navHtml = shownPages.map(
    (p, i) => `<button class="nav-item${i === 0 ? " active" : ""}" data-page="${p.id}" style="--pc:${p.color}" role="tab" aria-selected="${i === 0}">${esc(p.label)}</button>`,
  ).join("");

  const pagesHtml = shownPages.map(
    (p, i) => `
    <section class="page${i === 0 ? " page-active" : ""}" data-page="${p.id}" role="tabpanel" id="page-${p.id}">
      ${pageBodies[p.id]}
    </section>`,
  ).join("");

  const script = `<script>
(function(){
  // ── Browser-side helpers (esc/fmt — module-scope versions are NOT available here) ──
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmt(n){ return Number(n || 0).toLocaleString('en-US'); }

  // ── Tab switching ────────────────────────────────────────────────────────
  var navButtons = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-page]'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page[data-page]'));
  // Only the tabs actually rendered for this viewer are valid.
  var validIds = navButtons.map(function(b){ return b.dataset.page; });
  var DEFAULT_ID = validIds.length ? validIds[0] : '';

  function show(id){
    if (validIds.indexOf(id) === -1) id = DEFAULT_ID;
    pages.forEach(function(p){
      var active = p.dataset.page === id;
      var wasActive = p.classList.contains('page-active');
      if (active && wasActive) return;            // already showing — no-op (avoids reflow flicker)
      p.classList.remove('page-active');           // remove first so the fade restarts cleanly
      if (active) {
        // force reflow so the browser commits the hidden state before re-showing,
        // guaranteeing the fadeIn animation replays and layout is correct.
        void p.offsetWidth;
        p.classList.add('page-active');
      }
    });
    navButtons.forEach(function(b){
      var active = b.dataset.page === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    try { history.replaceState(null, '', '#' + id); } catch(e) {}
    // Fire loaders for tabs that need fresh data on activation.
    if (id === 'cases')    { try { window.adminLoadCases();    } catch(e) { console.error(e); } }
    if (id === 'userlist') { try { window.adminLoadAdmins();   } catch(e) { console.error(e); } }
    if (id === 'battles')  { try { window.adminLoadBattles();  } catch(e) { console.error(e); } }
    if (id === 'tickets')  { try { window.adminLoadTickets();  } catch(e) { console.error(e); } }
  }

  window.adminLoadTickets = function adminLoadTickets(){
    fetch('/api/admin/tickets').then(function(r){return r.json()}).then(function(d){
      var list=(d&&d.tickets)||[]; var el=document.getElementById('tkAdminList'); if(!el)return;
      // remember which tickets are expanded + any half-typed reply, so a re-render (e.g. after replying) doesn't collapse them
      var EXP={}, REP={};
      el.querySelectorAll('[data-tkid]').forEach(function(c){ var th=c.querySelector('.atk-thread'); if(th&&th.style.display!=='none')EXP[c.getAttribute('data-tkid')]=1; });
      el.querySelectorAll('.atk-thread input').forEach(function(i){ if(i.value)REP[i.id]=i.value; });
      if(!list.length){ el.innerHTML='<div style="padding:1.4rem;text-align:center;color:var(--text-dim)">No tickets.</div>'; return; }
      el.innerHTML=list.map(function(t){
        var msgs=(t.messages||[]).map(function(m){
          return '<div style="font-size:.78rem;margin:.25rem 0;padding:.35rem .55rem;border-radius:7px;background:'+(m.from==='admin'?'rgba(34,197,94,.12)':'var(--surface)')+'"><b style="color:var(--text-dim);font-size:.62rem">'+(m.from==='admin'?'Admin':esc(t.tag||'User'))+'</b><br>'+esc(m.body)+'</div>';
        }).join('');
        var open=t.status!=='closed';
        var controls='<div style="display:flex;gap:.4rem;margin-top:.4rem">'+(open?('<input class="input" id="atk-'+t._id+'" placeholder="Reply…" style="flex:1" onkeydown="if(event.key===&quot;Enter&quot;)adminTicketReply(\\''+t._id+'\\')"><button class="btn btn-primary" onclick="adminTicketReply(\\''+t._id+'\\')">Send</button><button class="btn-danger" onclick="adminTicketClose(\\''+t._id+'\\')">Close</button>'):'<span style="flex:1"></span>')+'<button class="btn-danger" onclick="adminTicketDelete(\\''+t._id+'\\')">Delete</button></div>';
        // collapsed by default — click the header to expand the thread (expanded state preserved across re-render)
        var disp=EXP[t._id]?'block':'none';
        return '<div data-tkid="'+t._id+'" style="border:1px solid var(--border);border-radius:8px;padding:.45rem .65rem;margin-bottom:.4rem">'+
          '<div style="display:flex;align-items:center;gap:.5rem;cursor:pointer" onclick="var b=this.nextElementSibling;b.style.display=b.style.display===&quot;none&quot;?&quot;block&quot;:&quot;none&quot;">'+
            '<b style="flex:1;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(t.subject)+'</b>'+
            '<span style="font-size:.58rem;text-transform:uppercase;color:var(--text-dim)">'+esc(t.status)+'</span>'+
            '<span style="font-size:.55rem;color:var(--text-dim)">'+esc(t.tag||'')+'</span>'+
          '</div>'+
          '<div class="atk-thread" style="display:'+disp+';margin-top:.45rem">'+msgs+controls+'</div>'+
        '</div>';
      }).join('');
      Object.keys(REP).forEach(function(id){ var i=document.getElementById(id); if(i)i.value=REP[id]; }); // restore typed reply
    }).catch(function(e){ console.error('tickets',e); });
  };
  window.adminTicketReply=function(id){
    var inp=document.getElementById('atk-'+id); var body=inp?inp.value.trim():''; if(!body)return;
    fetch('/api/admin/tickets/'+id+'/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:body})})
      .then(function(r){return r.json()}).then(function(){ window.adminLoadTickets(); }).catch(function(){});
  };
  window.adminTicketClose=function(id){
    fetch('/api/admin/tickets/'+id+'/close',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json()}).then(function(){ window.adminLoadTickets(); }).catch(function(){});
  };
  window.adminTicketDelete=function(id){
    if(!confirm('Delete this ticket permanently?'))return;
    fetch('/api/admin/tickets/'+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(){ window.adminLoadTickets(); }).catch(function(){});
  };
  // Live tickets: the admin page is standalone (no sidebar socket), so open our own
  // WS and refresh the ticket list whenever any ticket changes (new / reply / status).
  (function(){
    if(window.__adminWs)return; window.__adminWs=1;
    function conn(){
      var ws; try{ ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'); }catch(e){ setTimeout(conn,3000); return; }
      ws.onmessage=function(ev){ var d; try{d=JSON.parse(ev.data);}catch(e){return;} if(d&&d.type==='ticket'&&window.adminLoadTickets)window.adminLoadTickets(); };
      ws.onerror=function(){ try{ws.close();}catch(e){} };
      ws.onclose=function(){ setTimeout(conn,3000); };
    }
    conn();
  })();
  window.adminWipeDb=function(){
    if(!confirm('This PERMANENTLY erases the ENTIRE database. Continue?')) return;
    var phrase=prompt('Type exactly:  WIPE EVERYTHING'); if(phrase!=='WIPE EVERYTHING'){ if(phrase!==null)alert('Phrase did not match. Aborted.'); return; }
    var oid=prompt('Type your OWNER user ID to confirm:'); if(!oid) return;
    if(!confirm('FINAL WARNING: wipe all balances, tickets, tiers and stats now?')) return;
    fetch('/api/admin/wipe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'WIPE EVERYTHING',ownerId:oid.trim(),ack:true})})
      .then(function(r){return r.json()}).then(function(d){ alert(d&&d.ok?'Database wiped.':((d&&d.error)||'Wipe failed.')); })
      .catch(function(){ alert('Wipe request failed.'); });
  };

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
  show(validIds.indexOf(initial) !== -1 ? initial : DEFAULT_ID);

  window.addEventListener('hashchange', function(){
    var page = (location.hash || '').replace('#', '');
    if (validIds.indexOf(page) !== -1) show(page);
  });

  // ── Expose admin functions on window so inline onclick="" handlers work ─
  // (Inline handlers in the rendered HTML reference these by name.)

  window.adminLoadCases = function adminLoadCases(){
    fetch('/api/admin/cases').then(function(r){return r.json()}).then(function(d){
      var tiers = (d && d.tiers) || [];
      window._adminTiers = tiers;
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
        var safeId = String(t.id).replace(/'/g,"\\\\'");
        var actionCell = t.builtIn
          ? '<span style="color:var(--text-dim)">&mdash;</span>'
          : '<div style="display:flex;gap:.4rem"><button class="btn btn-ghost" style="padding:.25rem .6rem;font-size:.7rem" onclick="adminEditCase(\\''+safeId+'\\')">Edit</button>'+
            '<button class="btn-danger" onclick="adminDeleteCase(\\''+safeId+'\\')">Delete</button></div>';
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
    // Seed the creator form once (≥1 item row + entry→RTP listener).
    var rows = document.getElementById('ct-rows');
    if (rows && !rows.children.length) { window.adminAddItemRow(); }
    var entryEl = document.getElementById('ct-entry');
    if (entryEl && !entryEl._rtpBound) { entryEl._rtpBound = true; entryEl.addEventListener('input', window.adminCalcRtp); }
  };

  // Build one item row [emoji][name][value][weight][remove].
  window.adminAddItemRow = function adminAddItemRow(s, n, v, w){
    var rows = document.getElementById('ct-rows');
    if (!rows) return;
    var row = document.createElement('div');
    row.className = 'ct-item-row';
    row.style.cssText = 'display:grid;grid-template-columns:60px 1fr 1fr 1fr 32px;gap:.5rem;margin-bottom:.4rem';
    row.innerHTML =
      '<input class="input ct-s" maxlength="4" style="text-align:center" placeholder="💎" value="'+esc(s||'')+'">' +
      '<input class="input ct-n" placeholder="Diamond" value="'+esc(n||'')+'">' +
      '<input class="input ct-v" type="number" min="0" placeholder="2000" value="'+(v!=null?esc(v):'')+'">' +
      '<input class="input ct-w" type="number" min="1" placeholder="10" value="'+(w!=null?esc(w):'')+'">' +
      '<button class="btn-danger" title="Remove" onclick="this.parentNode.remove();adminCalcRtp()" style="padding:0;font-size:1.1rem">&times;</button>';
    rows.appendChild(row);
    Array.prototype.forEach.call(row.querySelectorAll('input'), function(inp){ inp.addEventListener('input', adminCalcRtp); });
    adminCalcRtp();
  };

  // Live RTP = weighted-average item value ÷ entry cost.
  window.adminCalcRtp = function adminCalcRtp(){
    var el = document.getElementById('ct-rtp');
    if (!el) return;
    var entry = parseFloat((document.getElementById('ct-entry')||{}).value) || 0;
    var rows = document.querySelectorAll('#ct-rows .ct-item-row');
    var totW = 0, totV = 0;
    Array.prototype.forEach.call(rows, function(r){
      var v = parseFloat(r.querySelector('.ct-v').value) || 0;
      var w = parseFloat(r.querySelector('.ct-w').value) || 0;
      totW += w; totV += v * w;
    });
    if (!entry || !totW) { el.textContent = '—'; return; }
    var rtp = Math.round((totV / totW) / entry * 100);
    el.textContent = rtp + '%';
    el.style.color = rtp > 100 ? 'var(--red)' : 'var(--accent)';
  };

  window.adminAddCase = function adminAddCase(){
    var idEl = document.getElementById('ct-id');
    if (!idEl) return;
    window._adminEditId = null;
    idEl.value = '';
    idEl.disabled = false;
    document.getElementById('ct-label').value = '';
    document.getElementById('ct-entry').value = '';
    document.getElementById('ct-color').value = '#22c55e';
    document.getElementById('ct-rows').innerHTML = '';
    var sb = document.getElementById('ct-save-btn'); if (sb) sb.textContent = 'Save tier';
    adminAddItemRow();
    adminCalcRtp();
    idEl.focus();
  };

  // Load an existing custom tier into the form for editing.
  window.adminEditCase = function adminEditCase(id){
    var tier = (window._adminTiers || []).filter(function(t){ return String(t.id) === String(id); })[0];
    if (!tier) { alert('Tier not found.'); return; }
    if (tier.builtIn) { alert('Built-in tiers cannot be edited.'); return; }
    window._adminEditId = String(tier.id);
    document.getElementById('ct-id').value = tier.id;
    document.getElementById('ct-id').disabled = true;
    document.getElementById('ct-label').value = tier.label || '';
    document.getElementById('ct-entry').value = tier.entry || '';
    document.getElementById('ct-color').value = tier.color || '#22c55e';
    document.getElementById('ct-rows').innerHTML = '';
    (tier.items || []).forEach(function(it){ adminAddItemRow(it.s, it.n, it.v, it.w); });
    if (!(tier.items || []).length) adminAddItemRow();
    var sb = document.getElementById('ct-save-btn'); if (sb) sb.textContent = 'Update tier';
    adminCalcRtp();
    document.getElementById('ct-label').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.adminSaveCase = function adminSaveCase(){
    var id    = ((document.getElementById('ct-id')    || {}).value || '').trim();
    var label = ((document.getElementById('ct-label') || {}).value || '').trim();
    var entry = parseInt((document.getElementById('ct-entry') || {}).value) || 0;
    var color = ((document.getElementById('ct-color') || {}).value || '').trim() || '#22c55e';
    if (!id || !label || !entry) { alert('ID, label, and entry cost are required.'); return; }
    var items = [];
    var rows = document.querySelectorAll('#ct-rows .ct-item-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var s = r.querySelector('.ct-s').value.trim();
      var n = r.querySelector('.ct-n').value.trim();
      var v = parseInt(r.querySelector('.ct-v').value);
      var w = parseInt(r.querySelector('.ct-w').value);
      if (!s || !n || !(v >= 0) || !(w > 0)) { alert('Item ' + (i+1) + ' is incomplete (need emoji, name, value, weight).'); return; }
      items.push({ s:s, n:n, v:v, w:w });
    }
    if (!items.length) { alert('Add at least one item.'); return; }
    var editId = window._adminEditId;
    var url = editId ? ('/api/admin/cases/' + encodeURIComponent(editId)) : '/api/admin/cases';
    var method = editId ? 'PUT' : 'POST';
    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id:id, label:label, entry:entry, color:color, bg:'#0a1f0a', items:items })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.error) { alert(d.error); return; }
        alert(editId ? 'Tier updated!' : 'Tier saved!');
        window.adminAddCase();
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

  // ── User List: search + admins, render rows w/ balance + perm toggles ──────
  function ulCfg(){ return window.__UL_CFG__ || { canBal:false, canPerms:false, owner:'', perms:[], permLabels:[] }; }

  function ulRenderRows(users){
    var cfg = ulCfg();
    var tbody = document.getElementById('ulTableBody');
    if (!tbody) return;
    var span = 2 + (cfg.canPerms ? cfg.perms.length : 0) + 1;
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="'+span+'" style="text-align:center;color:var(--text-dim);padding:1rem">No users found</td></tr>'; return; }
    tbody.innerHTML = users.map(function(u){
      var id = String(u.id || u._id);
      var safeId = id.replace(/'/g, "\\\\'");
      var perms = u.perms || [];
      var isOwner = id === cfg.owner;
      var name = u.tag || id;
      var av = u.avatar || u.av || '';
      var avCell = (av ? '<img src="'+esc(av)+'" style="width:26px;height:26px;border-radius:50%;vertical-align:middle;margin-right:.5rem" onerror="this.style.display=\\'none\\'">' : '');
      var userCell = '<td>'+avCell+'<span style="font-weight:600">'+esc(name)+'</span>'+
                     '<div class="uid" style="font-size:.6rem">'+esc(id)+(isOwner?' &middot; <b style="color:var(--accent)">OWNER</b>':'')+'</div></td>';
      var balCell = '<td class="bal-val">'+fmt(u.bal)+' FC'+
        (cfg.canBal ? ' <button class="btn-danger" style="margin-left:.4rem" onclick="adminShowBalModal(\\''+safeId+'\\','+(u.bal||0)+')">Edit</button>' : '')+'</td>';
      var permCells = '';
      if (cfg.canPerms){
        permCells = cfg.perms.map(function(pid){
          var on = perms.indexOf(pid) !== -1;
          if (isOwner) return '<td style="text-align:center;color:var(--accent)">✓</td>';
          return '<td style="text-align:center"><input type="checkbox" '+(on?'checked':'')+' onchange="adminTogglePerm(\\''+safeId+'\\',\\''+pid+'\\',this.checked)" style="accent-color:var(--accent);cursor:pointer"></td>';
        }).join('');
      }
      var adminBadge = (isOwner || perms.length) ? '<span style="color:var(--gold);font-size:.66rem;font-weight:600">'+(isOwner?'Owner':'Admin')+'</span>' : '<span style="color:var(--text-dim);font-size:.66rem">—</span>';
      return '<tr>'+userCell+balCell+permCells+'<td>'+adminBadge+'</td></tr>';
    }).join('');
  }

  window.adminSearchUsers = function adminSearchUsers(){
    var el = document.getElementById('ul-search');
    var q = el ? el.value.trim() : '';
    fetch('/api/admin/users?search=' + encodeURIComponent(q) + '&limit=30')
      .then(function(r){ return r.json(); })
      .then(function(d){ ulRenderRows((d && d.users) || []); })
      .catch(function(e){ console.error('adminSearchUsers', e); });
  };

  window.adminLoadAdmins = function adminLoadAdmins(){
    fetch('/api/admin/admins')
      .then(function(r){ return r.json(); })
      .then(function(d){ ulRenderRows((d && d.users) || []); })
      .catch(function(e){ console.error('adminLoadAdmins', e); });
  };

  window.adminTogglePerm = function adminTogglePerm(uid, perm, on){
    fetch('/api/admin/users/' + encodeURIComponent(uid) + '/perms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perm: perm, grant: !!on })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d && d.error){ alert(d.error); window.adminSearchUsers(); } })
      .catch(function(e){ alert('Error: ' + e.message); });
  };

  window.adminShowBalModal = function adminShowBalModal(uid, currentBal){
    var newBal = prompt('Set balance for '+uid+'\\nCurrent: '+currentBal+' FC\\nEnter new balance or delta (+100, -50):');
    if (newBal === null) return;
    var delta;
    if (String(newBal).charAt(0) === '+' || String(newBal).charAt(0) === '-') { delta = Number(newBal); }
    else { delta = Number(newBal) - currentBal; }
    if (isNaN(delta)) { alert('Invalid number.'); return; }
    fetch('/api/admin/users/' + encodeURIComponent(uid) + '/balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: delta })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){ alert('Balance updated to ' + d.bal + ' FC'); window.adminSearchUsers(); })
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
  if (startHash === 'cases')    { try { window.adminLoadCases();   } catch(e) {} }
  if (startHash === 'userlist') { try { window.adminLoadAdmins();  } catch(e) {} }
  if (startHash === 'battles')  { try { window.adminLoadBattles(); } catch(e) {} }
})();
</script>`;

  return shell(
    `<div class="app">
  <header class="topbar">
    <div class="topbar-inner">
      <div class="logo">
        <span class="logo-icon">🎰</span>
        <div><div class="logo-text">SirGreen</div><div class="logo-sub">Admin</div></div>
      </div>
      <nav class="nav" role="tablist">${navHtml}</nav>
      <div class="topbar-end">
        <span class="ts" title="Data refreshed at this time">↻ ${esc(refreshedAt)}</span>
        <a href="/logout" class="logout-btn" title="Logout">⏏</a>
      </div>
    </div>
  </header>
  <main class="main">${pagesHtml}</main>
</div>${script}`,
    "Admin Panel — SirGreen Casino",
  );
}

export class AdminPanel {
  /** @param {import('./Database.mjs').Database} db */
  constructor(db, prefix = "&", getCirculation = null, getBalances = null) {
    this.db = db;
    this.prefix = prefix;
    this.getCirculation = getCirculation;  // async () => { balances, banks, invested, total }
    this.getBalances = getBalances;        // async (uid[]) => { [uid]: balance }
  }

  static OWNER_ID = OWNER_ID;
  static PERMS = PERMS;
  static PERM_IDS = PERM_IDS;

  isOwner(userId) { return isOwner(userId); }

  /** Async admin check: owner OR holds at least one permission. */
  async isAdmin(userId) {
    if (isOwner(userId)) return true;
    try { const perms = await this.db.getPerms(userId); return Array.isArray(perms) && perms.length > 0; }
    catch { return false; }
  }

  /** Does this user have a specific permission? Owner always true. */
  async can(userId, perm) {
    if (isOwner(userId)) return true;
    try { const perms = await this.db.getPerms(userId); return hasPerm(userId, perms, perm); }
    catch { return false; }
  }

  /** Can this user see the admin PANEL? (owner, or holds a perm mapping to a panel
   *  tab). Perms like `tax`/`servers` grant powers WITHOUT a panel tab, so they
   *  must not light up the Admin nav on their own. */
  async canSeePanel(userId) {
    if (isOwner(userId)) return true;
    try { const perms = await this.db.getPerms(userId); return visiblePages(userId, perms).length > 0; }
    catch { return false; }
  }

  /**
   * Renders the dashboard HTML for `uid`, showing only pages they may access.
   * Stats queries are skipped for non-owners (they can't see stats tabs).
   */
  async render(uid) {
    const perms = isOwner(uid) ? PERM_IDS : await this.db.getPerms(uid).catch(() => []);
    const allowed = visiblePages(uid, perms);
    const owner = isOwner(uid);

    let globals = {}, commands = [], guilds = [], daily = [], topUsers = [];
    if (owner) {
      [globals, commands, guilds, daily, topUsers] = await Promise.all([
        this.db.getGlobalTotals(),
        this.db.getCommandStats(),
        this.db.getGuilds(),
        this.db.getDailyStats(14),
        this.db.getAdminUserStats(20),
      ]);
      // Override the stale Mongo `totalBalance` with the REAL circulation from STDB +
      // invested holdings (Mongo's `bal` is a never-updated starter balance).
      if (this.getCirculation) {
        try {
          const circ = await this.getCirculation();
          globals.totalBalance = circ.total || 0;
          globals.circulation = circ;  // { balances, banks, invested, total }
        } catch {}
      }
      // Enrich top users with LIVE STDB balances (Mongo `bal` is a stale 1000 starter).
      if (this.getBalances) {
        try {
          const live = await this.getBalances(topUsers.map(u => u._id));
          for (const u of topUsers) { if (live[u._id] != null) u.bal = live[u._id]; }
          // Re-sort by real balance descending
          topUsers.sort((a, b) => (b.bal ?? 0) - (a.bal ?? 0));
        } catch {}
      }
    }
    return buildPage({
      globals, commands, guilds, daily, topUsers,
      buildAt: Date.now(),
      uid, perms, allowed, owner,
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
