// Grid arena: COLS x ROWS, 1 entity = 1 cell. Shared board, parallel fan-out.
(function () {
  "use strict";
  var COLS = 16, ROWS = 11, CELL = 50, W = COLS*CELL, H = ROWS*CELL;
  var PALETTE = ["#5eead4","#f472b6","#a78bfa","#fbbf24","#60a5fa","#a3e635","#fb923c","#f87171","#2dd4bf","#e879f9"];
  function colorFor(id) {
    var h = 0; for (var i = 0; i < id.length; i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  var DEFAULT_MODELS = ["typesafe/jev-1.13", "openai/gpt-6-luna-decisions", "microsoft/microsoft-decision-1"];
  var catalog = [];
  var selectedIds = DEFAULT_MODELS.slice();
  var pendingIds = [];
  var modalFilter = "";
  try {
    var raw = localStorage.getItem("drone.models.selected");
    if (raw) { var p = JSON.parse(raw); if (Array.isArray(p) && p.length) selectedIds = p; }
  } catch (e) { /* ignore */ }
  function saveSelected(){ try { localStorage.setItem("drone.models.selected", JSON.stringify(selectedIds)); } catch (e) {} }
  function metaFor(id) {
    for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return catalog[i];
    return { id: id, label: id.split("/").pop(), vendor: "custom", isFree: false };
  }
  function normalizeSelected() {
    var valid = {}; catalog.forEach(function(m){ valid[m.id] = 1; });
    selectedIds = selectedIds.filter(function(id){ return valid[id]; });
    if (!selectedIds.length) DEFAULT_MODELS.forEach(function(d){ if (valid[d] && selectedIds.indexOf(d)===-1) selectedIds.push(d); });
    if (!selectedIds.length && catalog.length) selectedIds = [catalog[0].id];
    saveSelected();
  }
  var world = { cols: COLS, rows: ROWS, tick: 0, hazards: [], batteries: [], goals: [], drones: [], situations: [] };
  var SITU_ROTATION = ["storm", "cache", "gold"];
  var situIdx = 0;
  var history = []; // [{t, scores:{modelId: score}}] capped at 200 — feeds the Analytics sparkline
  var heatFilter = "all";
  var paused = false, autoWaves = true, lastWave = performance.now(), lastDecision = 0;
  var liveMode = false; // false = mock always; true = OpenRouter when key present
  var verboseTrace = true; // per-decision 🧠 lines in Events
  var payloadFollow = null; // model id the payload tab follows; defaults to first drone
  var stats = {};

  function $(id){ return document.getElementById(id); }
  var logEl, lbEl, pillsEl, payloadEl, tickEl, arenaMeta;
  function rnd(n){ return Math.floor(Math.random()*n); }
  function freeCell(exclude){
    for (var t = 0; t < 200; t++) {
      var c = rnd(COLS), r = rnd(ROWS), k = c+","+r;
      if (exclude[k]) continue;
      return { c: c, r: r };
    }
    return null;
  }
  function occupiedSet(){
    var s = {};
    world.hazards.concat(world.batteries, world.goals).forEach(function(o){ s[o.c+","+o.r]=1; });
    world.drones.forEach(function(d){ if(!d.dead) s[d.c+","+d.r]=1; });
    return s;
  }
  function log(msg){
    var d = document.createElement("div");
    d.innerHTML = '<span class="t">t'+world.tick+'</span>' + msg;
    logEl.prepend(d);
    while (logEl.children.length > 30) logEl.lastChild.remove();
    var ec = $("eventCount"); if (ec) ec.textContent = logEl.children.length;
  }

  function makeDrones(fresh){
    var starts = [{c:1,r:1},{c:COLS-2,r:1},{c:COLS-2,r:ROWS-2},{c:1,r:ROWS-2},{c:8,r:5},{c:4,r:5},{c:11,r:5},{c:8,r:2}];
    var i = 0;
    var keep = {};
    if (!fresh) world.drones.forEach(function(d){ keep[d.model] = { battery: d.battery, score: d.score }; });
    world.drones = selectedIds.map(function(id){
      var m = metaFor(id), s = starts[i++ % starts.length];
      var prev = keep[id];
      return { model:id, label:m.label, color:colorFor(id), c:s.c, r:s.r,
        px:(s.c+0.5)*CELL, py:(s.r+0.5)*CELL,
        battery: prev ? prev.battery : 100, score: prev ? prev.score : 0, trail: [], visits: {},
        hoverStreak: 0, dead:false, lastMove:"—", lastMs:null, lastEngine:null, _pending: null };
    });
    selectedIds.forEach(function(id){
      if(!stats[id]) stats[id]={calls:0,errors:0,lat:[],crashes:0,pickups:0,pads:0,forced:0,outraced:0,fallbacks:0,moves:{up:0,down:0,left:0,right:0,hover:0}};
      var s = stats[id];
      if(s.pads==null) s.pads=0; if(s.forced==null) s.forced=0; if(s.outraced==null) s.outraced=0; if(s.fallbacks==null) s.fallbacks=0;
      if(!s.moves) s.moves={up:0,down:0,left:0,right:0,hover:0};
    });
    renderPayloadSelect();
    renderHeatSelect();
  }
  var allDeadNotified = false;
  function restartRace(){
    allDeadNotified = false;
    world.situations = [];
    world.goals.forEach(function(g){ g.gold = false; });
    makeDrones(true);
    renderPills(); renderLB();
    log("🏁 race restarted — batteries full, scores kept");
  }

  function spawn(n, kind){
    if (kind === "hazards") n = Math.min(n, Math.max(0, rules().maxObs - world.hazards.length));
    if (kind === "batteries") n = Math.min(n, Math.max(0, 6 - world.batteries.length));
    if (kind === "goals") n = Math.min(n, Math.max(0, 2 - world.goals.length));
    var ex = occupiedSet();
    for (var i=0;i<n;i++){ var cell = freeCell(ex); if(!cell) return; ex[cell.c+","+cell.r]=1; world[kind].push(cell); }
    lastWave = performance.now();
  }

  function renderPills(){
    pillsEl.innerHTML = "";
    var add = document.createElement("span");
    add.className = "pill add";
    add.textContent = "＋ Models (" + selectedIds.length + ")";
    add.onclick = openModelsModal;
    pillsEl.appendChild(add);
  }

  // ---- model picker modal ----
  function filteredCatalog(){
    var q = (modalFilter||"").trim().toLowerCase();
    if (!q) return catalog.slice();
    return catalog.filter(function(m){ return (m.id+" "+m.label+" "+m.vendor).toLowerCase().indexOf(q) !== -1; });
  }
  function renderModelModalList(){
    var listEl = $("modelModalList"); if (!listEl) return;
    var sel = {}; pendingIds.forEach(function(id){ sel[id] = 1; });
    var items = filteredCatalog();
    var meta = $("modalCatalogMeta");
    if (meta) meta.textContent = catalog.length + " decision models · " + catalog.filter(function(m){return m.isFree;}).length + " free";
    if (!items.length) { listEl.innerHTML = '<div class="modal-empty">No models match.</div>'; return; }
    var lastVendor = "", html = "";
    items.forEach(function(m){
      if (m.vendor !== lastVendor) { lastVendor = m.vendor; html += '<div class="modal-vendor">'+lastVendor+'</div>'; }
      var on = !!sel[m.id];
      html += '<label class="modal-model-row'+(m.isFree?" is-free":"")+(on?" selected":"")+'">' +
        '<input type="checkbox" class="modal-check" data-id="'+m.id+'"'+(on?" checked":"")+' />' +
        '<span class="modal-model-main"><span class="modal-model-name">'+m.label +
        (m.isFree?'<span class="badge-free">Free</span>':"")+'</span>' +
        '<span class="modal-model-id">'+m.id+'</span></span></label>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll(".modal-check").forEach(function(cb){
      cb.addEventListener("change", function(){
        var id = cb.getAttribute("data-id");
        var set = {}; pendingIds.forEach(function(x){ set[x]=1; });
        if (cb.checked) set[id]=1; else delete set[id];
        pendingIds = Object.keys(set);
        var btn = $("modalApplyBtn"); if (btn) btn.textContent = pendingIds.length ? "Apply ("+pendingIds.length+")" : "Apply";
        var row = cb.closest(".modal-model-row"); if (row) row.classList.toggle("selected", cb.checked);
      });
    });
    var btn2 = $("modalApplyBtn"); if (btn2) btn2.textContent = pendingIds.length ? "Apply ("+pendingIds.length+")" : "Apply";
  }
  function openModelsModal(){
    pendingIds = selectedIds.slice(); modalFilter = "";
    var s = $("modelModalSearch"); if (s) s.value = "";
    var b = $("modelsModal"); if (b) { b.hidden = false; document.body.classList.add("modal-open"); }
    renderModelModalList();
  }
  function closeModelsModal(){
    var b = $("modelsModal"); if (b) { b.hidden = true; document.body.classList.remove("modal-open"); }
  }
  async function refreshCatalog(){
    var P = window.DroneProviders;
    var btn = $("modalRefreshBtn"); if (btn) btn.disabled = true;
    try {
      var keyEl = $("key-openrouter");
      var key = keyEl ? keyEl.value : "";
      catalog = await P.fetchOpenRouterDecisionModels(key);
    } catch (e) { catalog = window.DroneProviders.DECISIONS_CATALOG_FALLBACK.slice(); }
    if (btn) btn.disabled = false;
    normalizeSelected(); renderPills(); renderLB();
    if ($("modelsModal") && !$("modelsModal").hidden) renderModelModalList();
  }

  function rules() { return (window.DroneProviders && window.DroneProviders.RULES) || { move:5, hover:1, wall:5, hazard:10, charge:30, pad:50, low:30 }; }
  // payload inspector follows one drone (default: first). Selection persists by model id.
  function followedDrone(){
    for (var i = 0; i < world.drones.length; i++) if (world.drones[i].model === payloadFollow) return world.drones[i];
    return world.drones[0] || null;
  }
  function renderPayloadSelect(){
    var sel = $("payloadDrone"); if (!sel) return;
    var cur = payloadFollow;
    sel.innerHTML = "";
    world.drones.forEach(function(d){
      var o = document.createElement("option");
      o.value = d.model; o.textContent = d.label;
      sel.appendChild(o);
    });
    if (world.drones.some(function(d){ return d.model === cur; })) sel.value = cur;
    payloadFollow = sel.value || null;
  }
  function renderHeatSelect(){
    var sel = $("heatDrone"); if (!sel) return;
    var cur = heatFilter;
    sel.innerHTML = '<option value="all">All drones</option>';
    world.drones.forEach(function(d){
      var o = document.createElement("option");
      o.value = d.model; o.textContent = d.label;
      sel.appendChild(o);
    });
    sel.value = "all";
    world.drones.forEach(function(d){ if (d.model === cur) sel.value = cur; });
    heatFilter = sel.value || "all";
  }
  function rgba(hex, a) {
    var h = String(hex || "#5eead4").replace("#", "");
    if (h.length === 3) h = h.split("").map(function(c){ return c + c; }).join("");
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a.toFixed(2) + ")";
  }
  function renderHeatmap(){
    var cv = $("heatCanvas"); if (!cv) return;
    var ctx2 = cv.getContext("2d");
    var cw = cv.width, ch = cv.height, sx = cw / COLS, sy = ch / ROWS;
    var targets = world.drones.filter(function(d){ return heatFilter === "all" || d.model === heatFilter; });
    var max = 1;
    targets.forEach(function(d){
      Object.keys(d.visits || {}).forEach(function(k){ if (d.visits[k] > max) max = d.visits[k]; });
    });
    ctx2.clearRect(0, 0, cw, ch);
    ctx2.fillStyle = "#0a0f1a"; ctx2.fillRect(0, 0, cw, ch);
    targets.forEach(function(d){
      Object.keys(d.visits || {}).forEach(function(k){
        var parts = k.split(","), c = +parts[0], r = +parts[1];
        var a = 0.18 + 0.82 * Math.log(1 + d.visits[k]) / Math.log(1 + max);
        ctx2.fillStyle = rgba(d.color, a);
        ctx2.fillRect(c * sx + 1, r * sy + 1, sx - 2, sy - 2);
      });
    });
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
      ctx2.strokeStyle = "#1b2540"; ctx2.lineWidth = 1;
      ctx2.strokeRect(c * sx + 0.5, r * sy + 0.5, sx - 1, sy - 1);
    }
  }
  function renderAnalytics(){
    var body = $("analyticsBody"); if (!body) return;
    if (!history.length) { body.innerHTML = '<div class="muted">Waiting for ticks…</div>'; return; }
    var t = Math.max(1, world.tick);
    var rows = world.drones.slice().sort(function(a, b){ return b.score - a.score; }).map(function(d){
      var s = stats[d.model] || { calls: 0, errors: 0, lat: [], crashes: 0, pickups: 0, pads: 0, forced: 0, outraced: 0, fallbacks: 0 };
      var avg = s.lat.length ? Math.round(s.lat.reduce(function(a, b){ return a + b; }, 0) / s.lat.length) : 0;
      var fb = s.calls ? Math.round(100 * (s.fallbacks || 0) / s.calls) : 0;
      return '<tr><td style="color:' + d.color + '">' + d.label + '</td><td>' + d.score + '</td>' +
        '<td>' + (s.pads || 0) + '</td><td>' + (s.pickups || 0) + '</td><td>' + s.crashes + '</td>' +
        '<td>' + (d.score / t).toFixed(1) + '</td><td>' + s.calls + '</td><td>' + s.errors + '</td>' +
        '<td>' + avg + 'ms</td><td>' + fb + '%</td></tr>';
    }).join("");
    var maxMove = 1;
    world.drones.forEach(function(d){
      var m = (stats[d.model] || {}).moves || {};
      Object.keys(m).forEach(function(k){ if (m[k] > maxMove) maxMove = m[k]; });
    });
    var hists = world.drones.map(function(d){
      var m = ((stats[d.model] || {}).moves) || { up: 0, down: 0, left: 0, right: 0, hover: 0 };
      var bars = ["up", "down", "left", "right", "hover"].map(function(k){
        var w = Math.round(100 * (m[k] || 0) / maxMove);
        return '<div class="hbar"><span class="hm">' + k + '</span><span class="track"><span class="fill" style="width:' + w + '%;background:' + d.color + '"></span></span><span class="hv">' + (m[k] || 0) + '</span></div>';
      }).join("");
      var s2 = stats[d.model] || {};
      return '<div><h3 style="color:' + d.color + '">' + d.label + ' moves · forced ' + (s2.forced || 0) + ' · outraced ' + (s2.outraced || 0) + '</h3>' + bars + '</div>';
    }).join("");
    body.innerHTML = '<h3>Standings — score, pads, pickups, crashes, score/tick, calls, errors, avg, mock-fallback</h3>' +
      '<table class="stats"><tr><th>Model</th><th>Score</th><th>Pads</th><th>⚡</th><th>💥</th><th>Pt/t</th><th>Calls</th><th>Err</th><th>Avg</th><th>FB</th></tr>' + rows + '</table>' +
      '<h3>Score over time</h3><canvas id="sparkCanvas" width="560" height="120"></canvas>' +
      '<div class="analytics-grid">' + hists + '</div>';
    var cv = $("sparkCanvas");
    if (cv && history.length > 1) {
      var g = cv.getContext("2d"), W2 = cv.width, H2 = cv.height;
      g.clearRect(0, 0, W2, H2);
      var maxS = 1;
      history.forEach(function(h){ Object.keys(h.s).forEach(function(k){ if (h.s[k] > maxS) maxS = h.s[k]; }); });
      world.drones.forEach(function(d){
        g.strokeStyle = d.color; g.lineWidth = 2; g.beginPath();
        history.forEach(function(h, i){
          var x = 8 + (W2 - 16) * i / Math.max(1, history.length - 1);
          var y = H2 - 8 - (H2 - 20) * ((h.s[d.model] || 0) / maxS);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke();
      });
    }
  }
  function renderLB(){
    var R = rules();
    var ranked = world.drones.slice().sort(function(a, b){
      if (b.score !== a.score) return b.score - a.score;
      return b.battery - a.battery;
    });
    lbEl.innerHTML = ranked.map(function(d, i){
      var s = stats[d.model], avg = s.lat.length?Math.round(s.lat.reduce(function(a,b){return a+b;},0)/s.lat.length):0;
      var badge = d.dead?'<span class="badge dead">DEAD '+window.DroneProviders.cellName(d.c,d.r)+'</span>'
        :(d.battery<R.low?'<span class="badge low">'+window.DroneProviders.cellName(d.c,d.r)+' LOW</span>'
        :'<span class="badge ok">'+window.DroneProviders.cellName(d.c,d.r)+' · '+d.lastMove+'</span>');
      return '<div class="lb-row'+(i===0 && ranked.length>1?' leader':'')+'"><div class="lb-top"><span class="lb-name" style="color:'+d.color+'"><span class="rank muted">#'+(i+1)+' </span>'+d.label+'</span>'+badge+'</div>'+
        '<div class="lb-sub">'+d.model+'</div><div class="battbar '+(d.dead?"dead":(d.battery<R.low?"low":""))+'"><i style="width:'+Math.max(0,d.battery)+'%"></i></div>'+
        '<div class="lb-stats"><span>🔋<b>'+d.battery+'</b></span><span>★<b>'+d.score+'</b></span>'+
        '<span>crash<b>'+s.crashes+'</b></span><span>⚡<b>'+s.pickups+'</b></span></div>'+
        '<div class="lb-stats net"><span>calls<b>'+s.calls+'</b></span><span>avg<b>'+avg+'ms</b></span><span>last<b>'+(d.lastMs!=null?d.lastMs+"ms":"—")+'</b></span><span class="lb-del" data-model="'+d.model+'" title="Remove model">Delete</span></div></div>';
    }).join("") || '<div class="muted">No models enabled.</div>';
    var situTxt = world.situations.map(function(s){
      var icon = s.type === "storm" ? "⛈" : (s.type === "cache" ? "🔋" : "✨");
      return icon + " " + s.type + " in " + Math.max(0, s.firesAt - world.tick);
    }).join(" · ");
    arenaMeta.textContent = "tick "+world.tick+" · 16×11 · "+world.hazards.length+" hazards · "+world.batteries.length+" batteries · "+world.goals.length+" pads" + (situTxt ? " · " + situTxt : "");
    if (tickEl) tickEl.textContent = world.tick;
  }

  function getApiKey() {
    var el = $("key-openrouter");
    var raw = el ? el.value : "";
    var clean = window.DroneProviders && window.DroneProviders.cleanKey
      ? window.DroneProviders.cleanKey(raw) : String(raw||"").trim();
    if (el && clean !== el.value) el.value = clean; // strip pasted ZWSP immediately
    try {
      if (clean) localStorage.setItem("drone.key.openrouter", clean);
    } catch (e) { /* private mode */ }
    return liveMode ? clean : "";
  }
  function setStatus() {
    var label = $("serverStatusText"), dot = $("serverStatusDot");
    var keyEl = $("key-openrouter"), hasKey = keyEl && keyEl.value.trim();
    var text = paused ? "⏸ paused — 0 API calls"
      : liveMode ? (hasKey ? "LIVE — OpenRouter decisions" : "LIVE selected — paste key to start")
      : "Mock — no network";
    if (label) label.textContent = text;
    if (dot) dot.classList.toggle("ready", !paused && (!liveMode || !!hasKey));
    var mt = $("modeToggle");
    if (mt) { mt.textContent = liveMode ? "● LIVE" : "● Mock"; mt.classList.toggle("live", liveMode); }
    var rt = $("raceToggle");
    if (rt) { rt.textContent = paused ? "▶ Start" : "⏸ Pause"; rt.classList.toggle("paused", paused); }
    var pb = $("pauseBtn");
    if (pb) pb.textContent = paused ? "Start race" : "Pause";
  }
  function setPaused(p) {
    paused = !!p;
    setStatus();
  }

  async function decideAll(){
    if(!world.drones.length || paused) return;
    var P = window.DroneProviders;
    var alive = world.drones.filter(function(d){ return !d.dead; });
    if(!alive.length) {
      if (!allDeadNotified) { allDeadNotified = true; log("☠️ all drones dead — press <b>↻ Restart</b> for a new round (scores kept)"); renderLB(); }
      return;
    }
    var apiKey = getApiKey();
    await Promise.allSettled(alive.map(function(d){
      var st = P.buildDroneState(world, d);
      if(followedDrone()===d){
        payloadEl.textContent = JSON.stringify(P.payloadPreview(st, d.model), null, 2);
        var pm = $("payloadMeta"); if (pm) pm.textContent = "tick " + world.tick + (apiKey ? " · LIVE" : " · mock");
      }
      return P.decideWithFallback(st, { model:d.model, apiKey:apiKey }).then(function(res){
        var s = stats[d.model]; s.calls++; s.lat.push(res.latencyMs); if(s.lat.length>20)s.lat.shift();
        d.lastMove = res.chosen; d.lastMs = res.latencyMs; d.lastEngine = res.engine;
        d._pending = { move: res.chosen, st: st, res: res };
        if (res.fallback) { s.errors++; s.fallbacks=(s.fallbacks||0)+1; log("⚠️ <b style='color:"+d.color+"'>"+d.label+"</b> live failed ("+res.liveError+") — mock fallback"); }
        if (verboseTrace) {
          var so = st.stateObj;
          log("🧠 <b style='color:"+d.color+"'>"+d.label+"</b> "+so.me.at+" b"+so.me.batt+" → <b>"+res.chosen+"</b>" +
            " (PAD "+(so.pad.join(",")||"—")+" BATT "+(so.batt_cells.slice(0,3).join(",")||"—")+")" +
            " conf "+(res.confidence!=null?res.confidence:"n/a")+" "+res.latencyMs+"ms");
        }
      }).catch(function(err){ stats[d.model].errors++; log("❌ <b>"+d.label+"</b> decision error: "+(err&&err.message||err)); });
    }));
    // Deterministic order: grid order, not promise-resolution order. First to a pad
    // cell claims it; latecomers targeting the same cell hover instead (out-raced).
    // Hover cap: streak at maxHover forces the first safe move (hard backstop).
    var claimedPads = {};
    world.drones.forEach(function(d){
      if (!d._pending || d.dead) return;
      var pend = d._pending; d._pending = null;
      var R = rules();
      var mv = pend.move;
      if (mv === "hover" && (d.hoverStreak || 0) >= R.maxHover) {
        var forced = null;
        ["up", "down", "left", "right"].forEach(function(m){
          if (forced) return;
          var fx = d.c + P.DELTAS[m][0], fy = d.r + P.DELTAS[m][1];
          if (fx < 0 || fx >= COLS || fy < 0 || fy >= ROWS) return;
          if (at(world.hazards, fx, fy) !== -1) return;
          forced = m;
        });
        if (forced) {
          log("🚫 <b style='color:"+d.color+"'>"+d.label+"</b> hover limit ("+R.maxHover+") — forced "+forced);
          stats[d.model].forced = (stats[d.model].forced || 0) + 1;
          mv = forced;
        }
      }
      var dx = P.DELTAS[mv][0], dy = P.DELTAS[mv][1];
      var tc = d.c+dx, tr = d.r+dy, tk = tc+","+tr;
      var isPadTarget = mv !== "hover" && at(world.goals, tc, tr) !== -1;
      if (isPadTarget && claimedPads[tk]) {
        d.lastMove = "hover";
        stats[d.model].outraced = (stats[d.model].outraced || 0) + 1;
        log("🏁 <b style='color:"+d.color+"'>"+d.label+"</b> out-raced to pad — hovers");
        applyMove(d, "hover");
      } else {
        if (isPadTarget) claimedPads[tk] = 1;
        applyMove(d, mv);
      }
    });
    // hazards shamble one cell per tick but never onto pads/batteries (option a)
    world.hazards.forEach(function(h){
      var opts = [[0,0],[1,0],[-1,0],[0,1],[0,-1]][rnd(5)];
      var nc = Math.min(COLS-1, Math.max(0, h.c+opts[0])), nr = Math.min(ROWS-1, Math.max(0, h.r+opts[1]));
      if (at(world.goals, nc, nr) === -1 && at(world.batteries, nc, nr) === -1) { h.c = nc; h.r = nr; }
    });
    world.tick++;
    tickSituations();
    var snap = { t: world.tick, s: {} };
    world.drones.forEach(function(d){ snap.s[d.model] = d.score; });
    history.push(snap);
    if (history.length > 200) history.shift();
    renderLB();
    renderAnalytics();
    renderHeatmap();
  }

  // 3x3 block placement on the freest spot: tries random centers, keeps the
  // first block with 5+ free cells. findBlock only reserves; placeBlock fills.
  function findBlock(){
    var ex = occupiedSet(), best = [], tries = 0;
    while (best.length < 5 && tries < 20) {
      tries++;
      var cc = 1 + rnd(COLS - 2), cr = 1 + rnd(ROWS - 2), free = [];
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var bx = cc + ox, by = cr + oy;
        if (!ex[bx + "," + by]) free.push({ c: bx, r: by });
      }
      if (free.length >= 5) best = free;
    }
    return best;
  }
  function placeBlock(kind, cells){
    var pool = kind === "hazards" ? world.hazards : world.batteries;
    var cap = kind === "hazards"
      ? Math.max(0, rules().maxObs - pool.length)
      : Math.max(0, 9 - pool.length);
    if (cap <= 0) return [];
    var ex = occupiedSet();
    var placed = cells.filter(function(cell){ return !ex[cell.c + "," + cell.r]; }).slice(0, cap);
    placed.forEach(function(cell){
      ex[cell.c + "," + cell.r] = 1;
      pool.push(cell);
    });
    lastWave = performance.now();
    return placed;
  }
  function fireSituation(s){
    var P = window.DroneProviders;
    if (s.type === "storm") {
      var dropped = placeBlock("hazards", s.cells || []);
      log(dropped.length ? "⛈ <b>storm hits:</b> " + dropped.length + "-cell hazard block" : "⛈ <b>storm fizzles</b> — zone taken or at cap");
    } else if (s.type === "cache") {
      var placed = placeBlock("batteries", s.cells || []);
      var names = placed.map(function(cell){ return P.cellName(cell.c, cell.r); });
      log(placed.length ? "🔋 <b>cache lands:</b> " + placed.length + "-cell block @ " + names.join(", ") : "🔋 <b>cache fizzles</b> — zone taken");
    } else if (s.type === "gold") {
      var n = 0;
      world.goals.forEach(function(g){ if (!g.gold) { g.gold = true; n++; } });
      log("✨ <b>gold rush:</b> " + n + " pad" + (n === 1 ? "" : "s") + " pay double — first claim only");
    }
  }
  function at(list, c, r){ for(var i=list.length-1;i>=0;i--) if(list[i].c===c&&list[i].r===r) return i; return -1; }
  function tickSituations(){
    var R = rules();
    var lead = R.situLead == null ? 10 : R.situLead;
    var alive = world.drones.some(function(d){ return !d.dead; });
    // fire due
    for (var i = world.situations.length - 1; i >= 0; i--) {
      if (world.situations[i].firesAt <= world.tick) {
        fireSituation(world.situations[i]);
        world.situations.splice(i, 1);
      }
    }
    // schedule next when quiet (reserve the landing zone for the ghost preview)
    if (alive && !world.situations.length && Math.random() < 0.3) {
      var type = SITU_ROTATION[situIdx % SITU_ROTATION.length]; situIdx++;
      var entry = { type: type, firesAt: world.tick + lead };
      if (type === "storm" || type === "cache") entry.cells = findBlock();
      world.situations.push(entry);
      var names = { storm: "⛈ storm", cache: "🔋 cache", gold: "✨ gold rush" };
      log("📢 situation queued: <b>" + (names[type] || type) + "</b> in " + lead);
    }
  }

  function applyMove(d, move){
    var P = window.DroneProviders, R = rules(), dx = P.DELTAS[move][0], dy = P.DELTAS[move][1];
    var nc = d.c+dx, nr = d.r+dy;
    // ticks economy from ⚙ Rules (defaults: move −5, hover −1, wall −5, hazard −10)
    if(nc<0||nc>=COLS||nr<0||nr>=ROWS){ d.battery -= R.wall; log("🧱 <b style='color:"+d.color+"'>"+d.label+"</b> wall −"+R.wall); }
    else { d.c = nc; d.r = nr; d.battery -= (move==="hover"?R.hover:R.move); }
    d.hoverStreak = (move === "hover") ? (d.hoverStreak || 0) + 1 : 0;
    var vst = stats[d.model];
    if (vst && vst.moves && vst.moves[move] != null) vst.moves[move]++;
    d.visits = d.visits || {};
    d.visits[d.c + "," + d.r] = (d.visits[d.c + "," + d.r] || 0) + 1;
    d.trail = d.trail || [];
    d.trail.push(P.cellName(d.c, d.r));
    if (d.trail.length > 3) d.trail.shift();
    var bi = at(world.batteries, d.c, d.r);
    if(bi!==-1){ world.batteries.splice(bi,1); d.battery=Math.min(100,d.battery+R.charge); stats[d.model].pickups++; log("⚡ <b style='color:"+d.color+"'>"+d.label+"</b> +"+R.charge+" @ "+P.cellName(d.c,d.r)+" (now "+d.battery+")"); }
    var gi = at(world.goals, d.c, d.r);
    if(gi!==-1){
      var claimed = world.goals[gi];
      var mult = claimed.gold ? 2 : 1;
      world.goals.splice(gi,1); d.score+=R.pad*mult; d.battery=Math.min(100, R.padBatt == null ? 100 : R.padBatt); stats[d.model].pads = (stats[d.model].pads||0)+1;
      log((claimed.gold ? "🥇" : "🛬") + " <b style='color:"+d.color+"'>"+d.label+"</b> " + (claimed.gold ? "GOLD " : "PAD ") + "+"+(R.pad*mult)+" + batt "+d.battery+" @ "+P.cellName(d.c,d.r));
      var cell = freeCell(occupiedSet()); if (cell) world.goals.push(cell); // pad respawns elsewhere
    }
    if(at(world.hazards, d.c, d.r)!==-1){ d.battery-=R.hazard; stats[d.model].crashes++; d.score=Math.max(0,d.score-5); log("💥 <b style='color:"+d.color+"'>"+d.label+"</b> hazard −"+R.hazard+" @ "+P.cellName(d.c,d.r)+" (now "+d.battery+")"); }
    if(d.battery<=0){ d.battery=0; d.dead=true; log("☠️ <b style='color:"+d.color+"'>"+d.label+"</b> out of battery @ "+P.cellName(d.c,d.r)); }
    else d.score+=1;
  }

  var canvas, ctx, lastT = performance.now(), pulse = 0;
  function frame(now){
    var dt = Math.min(0.05,(now-lastT)/1000); lastT = now; pulse += dt;
    if(!paused){
      // smooth glide: pixel pos eases toward logical cell center — never halts on lines
      world.drones.forEach(function(d){
        var gx = (d.c+0.5)*CELL, gy = (d.r+0.5)*CELL, k = Math.min(1, dt*5);
        d.px += (gx-d.px)*k; d.py += (gy-d.py)*k;
        if(Math.abs(gx-d.px)<0.5) d.px=gx; if(Math.abs(gy-d.py)<0.5) d.py=gy;
      });
      if(autoWaves && now-lastWave>12000 && world.drones.some(function(d){ return !d.dead; })){ spawn(2,"hazards"); spawn(1,"batteries"); if(world.goals.length<3)spawn(1,"goals"); log("🌊 new wave"); renderLB(); }
      if(now-lastDecision>2000){ lastDecision=now; decideAll(); }
    }
    draw(); requestAnimationFrame(frame);
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle="#0a0f1a"; ctx.fillRect(0,0,W,H);
    for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
      var x=c*CELL, y=r*CELL;
      ctx.strokeStyle="#1b2540"; ctx.lineWidth=1; ctx.strokeRect(x+0.5,y+0.5,CELL-1,CELL-1);
    }
    // col letters + row numbers
    ctx.fillStyle="#4b5876"; ctx.font="10px monospace";
    for(var c2=0;c2<COLS;c2++) ctx.fillText(String.fromCharCode(65+c2), c2*CELL+20, 11);
    for(var r2=0;r2<ROWS;r2++) ctx.fillText(String(r2+1), 3, r2*CELL+26);
    function cellBox(c,r,fill,stroke){
      var x=c*CELL, y=r*CELL;
      ctx.fillStyle=fill; ctx.fillRect(x+3,y+3,CELL-6,CELL-6);
      if(stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=2; ctx.strokeRect(x+3,y+3,CELL-6,CELL-6); }
    }
    world.goals.forEach(function(g){
      if (g.gold) { cellBox(g.c,g.r,"#713f12","#fbbf24");
        ctx.fillStyle="#fef3c7"; ctx.font="bold 11px sans-serif"; ctx.textAlign="center"; ctx.fillText("GOLD", g.c*CELL+CELL/2, g.r*CELL+CELL/2+4); ctx.textAlign="left"; }
      else { cellBox(g.c,g.r,"#1e3a8a","#60a5fa");
        ctx.fillStyle="#bfdbfe"; ctx.font="bold 11px sans-serif"; ctx.textAlign="center"; ctx.fillText("PAD", g.c*CELL+CELL/2, g.r*CELL+CELL/2+4); ctx.textAlign="left"; }
    });
    world.batteries.forEach(function(b){ cellBox(b.c,b.r,"#3f6212","#a3e635");
      ctx.fillStyle="#ecfccb"; ctx.font="bold 15px sans-serif"; ctx.textAlign="center"; ctx.fillText("⚡", b.c*CELL+CELL/2, b.r*CELL+CELL/2+5); ctx.textAlign="left"; });
    world.hazards.forEach(function(h){ cellBox(h.c,h.r,"#7f1d1d","#f87171");
      ctx.fillStyle="#fecaca"; ctx.font="bold 14px sans-serif"; ctx.textAlign="center"; ctx.fillText("✕", h.c*CELL+CELL/2, h.r*CELL+CELL/2+5); ctx.textAlign="left"; });
    // ghost previews: reserved landing zones with countdown
    world.situations.forEach(function(s){
      if (!s.cells || !s.cells.length) return;
      var n = Math.max(0, s.firesAt - world.tick);
      var col = s.type === "storm" ? "#f87171" : "#a3e635";
      s.cells.forEach(function(cell, i){
        var x = cell.c*CELL, y = cell.r*CELL;
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        ctx.strokeRect(x+3, y+3, CELL-6, CELL-6);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (i === 0) {
          ctx.fillStyle = col; ctx.font = "bold 11px monospace"; ctx.textAlign = "center";
          ctx.fillText(n + "", x+CELL/2, y+16); ctx.textAlign = "left";
        }
      });
    });
    world.drones.forEach(function(d){
      var R = rules();
      var x=d.c*CELL, y=d.r*CELL;
      cellBox(d.c,d.r, d.dead?"#222c44":d.color+"33", d.dead?"#555":d.color);
      ctx.globalAlpha = d.dead?0.4:1;
      ctx.fillStyle = d.dead?"#888":d.color;
      ctx.beginPath(); ctx.arc(d.px, d.py-2, 11, 0, 7); ctx.fill();
      ctx.fillStyle="#0b0e14"; ctx.font="bold 10px sans-serif"; ctx.textAlign="center"; ctx.fillText(d.label[0], d.px, d.py+2); ctx.textAlign="left";
      ctx.globalAlpha = 1;
      ctx.fillStyle = d.dead?"#f87171":(d.battery<R.low?"#fbbf24":"#e8ecf4");
      ctx.font="bold 10px monospace"; ctx.textAlign="center"; ctx.fillText(d.battery+"", x+CELL/2, y+CELL-8); ctx.textAlign="left";
      if(!d.dead && d.battery<R.low){ ctx.fillStyle="#fbbf24"; ctx.font="bold 9px sans-serif"; ctx.textAlign="center"; ctx.fillText("LOW", x+CELL/2, y+13); ctx.textAlign="left"; }
    });
  }

  function boot(){
    canvas=$("arena"); ctx=canvas.getContext("2d");
    logEl=$("eventLog"); lbEl=$("leaderboard"); pillsEl=$("modelPills");
    payloadEl=$("jsonPayloadPreview"); tickEl=$("tickLabel"); arenaMeta=$("arenaMeta");
    lbEl.addEventListener("click", function(e){
      var t = e.target.closest ? e.target.closest(".lb-del") : null;
      if (!t) return;
      var id = t.getAttribute("data-model");
      var m = metaFor(id);
      selectedIds = selectedIds.filter(function(x){ return x !== id; });
      saveSelected(); makeDrones(); renderPills(); renderLB();
      log("➖ removed <b>"+m.label+"</b>");
    });
    // tabs under arena
    document.querySelectorAll(".tab").forEach(function(btn){
      btn.onclick = function(){
        document.querySelectorAll(".tab").forEach(function(b){ b.classList.toggle("active", b===btn); });
        ["events","heat","analytics","payload"].forEach(function(name){
          var p = $("panel-"+name); if (p) p.hidden = (name !== btn.getAttribute("data-tab"));
        });
      };
    });
    var copyBtn = $("copyPayloadBtn");
    if (copyBtn) copyBtn.onclick = function(){
      var t = payloadEl.textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ copyBtn.textContent="Copied!"; setTimeout(function(){ copyBtn.textContent="Copy"; },1200); });
    };
    var tt = $("traceToggle");
    if (tt) tt.onclick = function(){
      verboseTrace = !verboseTrace;
      tt.textContent = verboseTrace ? "trace on" : "trace off";
      tt.classList.toggle("on", verboseTrace);
      tt.classList.toggle("off", !verboseTrace);
    };
    var pd = $("payloadDrone");
    if (pd) pd.onchange = function(){ payloadFollow = pd.value || null; };
    var hd = $("heatDrone");
    if (hd) hd.onchange = function(){ heatFilter = hd.value || "all"; renderHeatmap(); };
    var hc = $("heatClearBtn");
    if (hc) hc.onclick = function(){
      world.drones.forEach(function(d){ d.visits = {}; });
      renderHeatmap();
      log("🧹 heatmap cleared");
    };
    makeDrones();
    spawn(4,"hazards"); spawn(3,"batteries"); spawn(2,"goals"); renderLB();
    var P = window.DroneProviders;
    renderPayloadSelect();
    var fol = followedDrone();
    if(fol){ var st=P.buildDroneState(world, fol);
      payloadEl.textContent=JSON.stringify(P.payloadPreview(st,fol.model),null,2); }
    log("🏁 grid live — 1 entity = 1 cell, hazards shamble 1 cell/tick");
    var keyEl = $("key-openrouter");
    var keyChip = $("keyChip");
    function refreshKeyVisibility(editing){
      var has = keyEl && keyEl.value.trim();
      if (keyEl) keyEl.hidden = !!(has && !editing);
      if (keyChip) keyChip.hidden = !(has && !editing);
    }
    try {
      keyEl.value = localStorage.getItem("drone.key.openrouter") || "";
      liveMode = localStorage.getItem("drone.mode") === "live";
    } catch (e) { /* ignore */ }
    refreshKeyVisibility(false);
    if (keyEl) {
      keyEl.addEventListener("input", function(){ getApiKey(); setStatus(); refreshKeyVisibility(true); });
      keyEl.addEventListener("change", function(){ refreshKeyVisibility(false); });
      keyEl.addEventListener("blur", function(){ refreshKeyVisibility(false); });
      keyEl.addEventListener("keydown", function(e){ if (e.key === "Escape") refreshKeyVisibility(false); });
    }
    if (keyChip) keyChip.onclick = function(){ refreshKeyVisibility(true); if (keyEl) keyEl.focus(); };
    var mt = $("modeToggle");
    if (mt) mt.onclick = function(){
      liveMode = !liveMode;
      try { localStorage.setItem("drone.mode", liveMode ? "live" : "mock"); } catch (e) { /* ignore */ }
      if (liveMode && getApiKey()) setPaused(true); // never burn calls on switch — user hits Start
      log(liveMode ? "● switched to <b>LIVE</b> — press Start to run" : "● switched to <b>Mock</b> — no network, key kept");
      setStatus();
    };
    var rt = $("raceToggle");
    if (rt) rt.onclick = function(){ setPaused(!paused); };
    var ck = $("clearKeyBtn");
    if (ck) ck.onclick = function(){
      if (keyEl) keyEl.value = "";
      try { localStorage.removeItem("drone.key.openrouter"); } catch (e) { /* ignore */ }
      liveMode = false;
      try { localStorage.setItem("drone.mode", "mock"); } catch (e) { /* ignore */ }
      log("● key cleared — back to <b>Mock</b>");
      refreshKeyVisibility(true);
      if (keyEl) keyEl.focus();
      setStatus();
    };
    setStatus();
    if (getApiKey()) { setPaused(true); log("🔑 key found — race held. Press <b>Start</b> when ready (no calls until then)."); }
    $("pauseBtn").onclick=function(){ setPaused(!paused); };
    $("restartBtn").onclick=function(){ restartRace(); };
    $("manualTriggerBtn").onclick=function(){
      if (paused) { log("⏸ paused — press Start to run, or step disabled to save API calls"); return; }
      decideAll();
    };
    $("autoBtn").onclick=function(){ autoWaves=!autoWaves; this.textContent="Auto waves: "+(autoWaves?"on":"off"); this.classList.toggle("active",autoWaves); };
    $("spawnHazardBtn").onclick=function(){ spawn(2,"hazards"); renderLB(); log("🌊 +2 hazards"); };
    $("spawnBatteryBtn").onclick=function(){ spawn(2,"batteries"); renderLB(); log("⚡ +2 batteries"); };
    $("clearBtn").onclick=function(){ world.hazards=[];world.batteries=[];world.goals=[]; renderLB(); log("🧹 cleared"); };
    // ⚙ Rules panel — numbers only, no code edits
    function refreshRulesLabels(){
      var R = rules();
      var rl = $("rulesLine");
      if (rl) rl.textContent = "Move −"+R.move+" · Hover −"+R.hover+" · Hazard −"+R.hazard+" · Batt +"+R.charge+" · Pad +"+R.pad;
      var lb = $("legendBatt");
      if (lb) lb.innerHTML = '<i class="sw battery"></i>battery cell, enter to +'+R.charge+' charge';
      var lp = $("legendPad");
      if (lp) lp.innerHTML = '<i class="sw goal"></i>landing pad, +'+R.pad+' score + batt to '+R.padBatt;
      var ll = $("legendLow");
      if (ll) ll.innerHTML = '<i class="sw low"></i>low battery (&lt;'+R.low+')';
    }
    function bindRule(id, field){
      var el = $(id);
      if (!el) return;
      el.value = rules()[field];
      el.addEventListener("change", function(){
        var v = parseInt(el.value, 10);
        if (isNaN(v)) { el.value = rules()[field]; return; }
        window.DroneProviders.RULES[field] = v;
        window.DroneProviders.saveRules();
        refreshRulesLabels(); renderLB();
        log("⚙ rule <b>"+field+"</b> → "+v+" (next tick uses it)");
      });
    }
    ["rule-move/move", "rule-hover/hover", "rule-wall/wall", "rule-hazard/hazard", "rule-charge/charge", "rule-pad/pad", "rule-padbatt/padBatt", "rule-low/low", "rule-maxobs/maxObs", "rule-maxhover/maxHover", "rule-situlead/situLead"].forEach(function(pair){
      var parts = pair.split("/"); bindRule(parts[0], parts[1]);
    });
    var rb = $("rulesResetBtn");
    if (rb) rb.onclick = function(){
      var D = window.DroneProviders.DEFAULT_RULES;
      Object.keys(D).forEach(function(k){ window.DroneProviders.RULES[k] = D[k]; });
      window.DroneProviders.saveRules();
      ["rule-move/move", "rule-hover/hover", "rule-wall/wall", "rule-hazard/hazard", "rule-charge/charge", "rule-pad/pad", "rule-padbatt/padBatt", "rule-low/low", "rule-maxobs/maxObs", "rule-maxhover/maxHover", "rule-situlead/situLead"].forEach(function(pair){
        var parts = pair.split("/"); var el = $(parts[0]); if (el) el.value = D[parts[1]];
      });
      refreshRulesLabels(); renderLB();
      log("⚙ rules reset to defaults");
    };
    refreshRulesLabels();
    // model picker modal wiring
    var mm = function(id, fn){ var el = $(id); if (el) el.onclick = fn; };
    mm("modalCloseBtn", closeModelsModal); mm("modalCancelBtn", closeModelsModal);
    var ms = $("modelModalSearch");
    if (ms) ms.addEventListener("input", function(e){ modalFilter = e.target.value; renderModelModalList(); });
    mm("modalRefreshBtn", function(){ refreshCatalog(); });
    mm("modalSelectFreeBtn", function(){
      var set = {}; pendingIds.forEach(function(id){ set[id]=1; });
      catalog.forEach(function(m){ if (m.isFree) set[m.id]=1; });
      pendingIds = Object.keys(set); renderModelModalList();
    });
    mm("modalClearBtn", function(){ pendingIds = []; renderModelModalList(); });
    mm("modalApplyBtn", function(){
      if (!pendingIds.length) { log("⚠️ select at least one model"); return; }
      selectedIds = pendingIds.slice(); saveSelected(); closeModelsModal();
      makeDrones(); renderPills(); renderLB();
      log("✅ racing <b>"+selectedIds.length+"</b> model"+(selectedIds.length===1?"":"s"));
    });
    var mb = $("modelsModal");
    if (mb) mb.addEventListener("click", function(e){ if (e.target === mb) closeModelsModal(); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeModelsModal(); });
    // catalog first (ported racer logic), then drones
    catalog = window.DroneProviders.DECISIONS_CATALOG_FALLBACK.slice();
    normalizeSelected(); makeDrones(); renderPills();
    refreshCatalog();
    requestAnimationFrame(frame);
  }
  window.addEventListener("DOMContentLoaded", boot);
})();
