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

function shell(body, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/assets/css/admin.css"></head><body>${body}</body></html>`;
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
        <button class="btn btn-primary" onclick="adminSaveCase()">Save tier</button>
        <button class="btn btn-ghost" onclick="adminAddCase()">Clear</button>
      </div>
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
  // ── Browser-side helpers (esc/fmt — module-scope versions are NOT available here) ──
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmt(n){ return Number(n || 0).toLocaleString('en-US'); }

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
    if (id === 'balances') { try { window.adminSearchUsers(); } catch(e) { console.error(e); } }
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
    idEl.value = '';
    document.getElementById('ct-label').value = '';
    document.getElementById('ct-entry').value = '';
    document.getElementById('ct-color').value = '#22c55e';
    document.getElementById('ct-rows').innerHTML = '';
    adminAddItemRow();
    adminCalcRtp();
    idEl.focus();
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
    fetch('/api/admin/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id:id, label:label, entry:entry, color:color, bg:'#0a1f0a', items:items })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.error) { alert(d.error); return; }
        alert('Tier saved!');
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
  if (startHash === 'cases')    { try { window.adminLoadCases();   } catch(e) {} }
  if (startHash === 'balances') { try { window.adminSearchUsers(); } catch(e) {} }
  if (startHash === 'battles')  { try { window.adminLoadBattles(); } catch(e) {} }
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
