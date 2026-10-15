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
  var world = { cols: COLS, rows: ROWS, tick: 0, hazards: [], batteries: [], goals: [], drones: [] };
  var paused = false, autoWaves = true, lastWave = performance.now(), lastDecision = 0;
  var liveMode = false; // false = mock always; true = OpenRouter when key present
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

  function makeDrones(){
    var starts = [{c:1,r:1},{c:COLS-2,r:1},{c:COLS-2,r:ROWS-2},{c:1,r:ROWS-2},{c:8,r:5},{c:4,r:5},{c:11,r:5},{c:8,r:2}];
    var i = 0;
    var keep = {};
    world.drones.forEach(function(d){ keep[d.model] = { battery: d.battery, score: d.score }; });
    world.drones = selectedIds.map(function(id){
      var m = metaFor(id), s = starts[i++ % starts.length];
      var prev = keep[id];
      return { model:id, label:m.label, color:colorFor(id), c:s.c, r:s.r,
        px:(s.c+0.5)*CELL, py:(s.r+0.5)*CELL,
        battery: prev ? prev.battery : 100, score: prev ? prev.score : 0,
        dead:false, lastMove:"—", lastMs:null, lastEngine:null };
    });
    selectedIds.forEach(function(id){ if(!stats[id]) stats[id]={calls:0,errors:0,lat:[],crashes:0,pickups:0}; });
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
    selectedIds.forEach(function(id){
      var m = metaFor(id);
      var s = document.createElement("span");
      s.className = "pill";
      s.title = id + " — click to remove";
      s.innerHTML = '<span class="swatch" style="background:'+colorFor(id)+'"></span>'+m.label+' <span class="muted">×</span>';
      s.onclick = function(){
        selectedIds = selectedIds.filter(function(x){ return x !== id; });
        saveSelected(); makeDrones(); renderPills(); renderLB();
        log("➖ removed <b>"+m.label+"</b>");
      };
      pillsEl.appendChild(s);
    });
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
  function renderLB(){
    var R = rules();
    lbEl.innerHTML = world.drones.map(function(d){
      var s = stats[d.model], avg = s.lat.length?Math.round(s.lat.reduce(function(a,b){return a+b;},0)/s.lat.length):0;
      var badge = d.dead?'<span class="badge dead">DEAD '+window.DroneProviders.cellName(d.c,d.r)+'</span>'
        :(d.battery<R.low?'<span class="badge low">'+window.DroneProviders.cellName(d.c,d.r)+' LOW</span>'
        :'<span class="badge ok">'+window.DroneProviders.cellName(d.c,d.r)+' · '+d.lastMove+'</span>');
      return '<div class="lb-row"><div class="lb-top"><span class="lb-name" style="color:'+d.color+'">'+d.label+'</span>'+badge+'</div>'+
        '<div class="lb-sub">'+d.model+'</div><div class="battbar '+(d.dead?"dead":(d.battery<R.low?"low":""))+'"><i style="width:'+Math.max(0,d.battery)+'%"></i></div>'+
        '<div class="lb-stats"><span>🔋<b>'+d.battery+'</b></span><span>★<b>'+d.score+'</b></span>'+
        '<span>crash<b>'+s.crashes+'</b></span><span>⚡<b>'+s.pickups+'</b></span></div>'+
        '<div class="lb-stats net"><span>calls<b>'+s.calls+'</b></span><span>avg<b>'+avg+'ms</b></span><span>last<b>'+(d.lastMs!=null?d.lastMs+"ms":"—")+'</b></span></div></div>';
    }).join("") || '<div class="muted">No models enabled.</div>';
    arenaMeta.textContent = "tick "+world.tick+" · 16×11 · "+world.hazards.length+" hazards · "+world.batteries.length+" batteries · "+world.goals.length+" pads";
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
      : liveMode ? (hasKey ? "● LIVE — OpenRouter decisions" : "● LIVE selected — paste key to start")
      : "● Mock — no network";
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
    if(!alive.length) return;
    var apiKey = getApiKey();
    await Promise.allSettled(alive.map(function(d){
      var st = P.buildDroneState(world, d);
      if(world.drones[0]===d){
        payloadEl.textContent = JSON.stringify(P.payloadPreview(st, d.model), null, 2);
        var pm = $("payloadMeta"); if (pm) pm.textContent = d.label + " · " + d.model + " · tick " + world.tick + (apiKey ? " · LIVE" : " · mock");
      }
      return P.decideWithFallback(st, { model:d.model, apiKey:apiKey }).then(function(res){
        var s = stats[d.model]; s.calls++; s.lat.push(res.latencyMs); if(s.lat.length>20)s.lat.shift();
        d.lastMove = res.chosen; d.lastMs = res.latencyMs; d.lastEngine = res.engine;
        d._pending = { move: res.chosen, st: st, res: res };
        if (res.fallback) { s.errors++; log("⚠️ <b style='color:"+d.color+"'>"+d.label+"</b> live failed ("+res.liveError+") — mock fallback"); }
        var vb = $("verboseLog");
        if (vb && vb.checked) {
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
          mv = forced;
        }
      }
      var dx = P.DELTAS[mv][0], dy = P.DELTAS[mv][1];
      var tc = d.c+dx, tr = d.r+dy, tk = tc+","+tr;
      var isPadTarget = mv !== "hover" && at(world.goals, tc, tr) !== -1;
      if (isPadTarget && claimedPads[tk]) {
        d.lastMove = "hover";
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
    renderLB();
  }

  function at(list, c, r){ for(var i=list.length-1;i>=0;i--) if(list[i].c===c&&list[i].r===r) return i; return -1; }

  function applyMove(d, move){
    var P = window.DroneProviders, R = rules(), dx = P.DELTAS[move][0], dy = P.DELTAS[move][1];
    var nc = d.c+dx, nr = d.r+dy;
    // ticks economy from ⚙ Rules (defaults: move −5, hover −1, wall −5, hazard −10)
    if(nc<0||nc>=COLS||nr<0||nr>=ROWS){ d.battery -= R.wall; log("🧱 <b style='color:"+d.color+"'>"+d.label+"</b> wall −"+R.wall); }
    else { d.c = nc; d.r = nr; d.battery -= (move==="hover"?R.hover:R.move); }
    d.hoverStreak = (move === "hover") ? (d.hoverStreak || 0) + 1 : 0;
    var bi = at(world.batteries, d.c, d.r);
    if(bi!==-1){ world.batteries.splice(bi,1); d.battery=Math.min(100,d.battery+R.charge); stats[d.model].pickups++; log("⚡ <b style='color:"+d.color+"'>"+d.label+"</b> +"+R.charge+" @ "+P.cellName(d.c,d.r)+" (now "+d.battery+")"); }
    var gi = at(world.goals, d.c, d.r);
    if(gi!==-1){
      world.goals.splice(gi,1); d.score+=R.pad; stats[d.model].pads = (stats[d.model].pads||0)+1;
      log("🛬 <b style='color:"+d.color+"'>"+d.label+"</b> PAD +"+R.pad+" @ "+P.cellName(d.c,d.r));
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
      if(autoWaves && now-lastWave>12000){ spawn(2,"hazards"); spawn(1,"batteries"); if(world.goals.length<3)spawn(1,"goals"); log("🌊 new wave"); renderLB(); }
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
    world.goals.forEach(function(g){ cellBox(g.c,g.r,"#1e3a8a","#60a5fa");
      ctx.fillStyle="#bfdbfe"; ctx.font="bold 11px sans-serif"; ctx.textAlign="center"; ctx.fillText("PAD", g.c*CELL+CELL/2, g.r*CELL+CELL/2+4); ctx.textAlign="left"; });
    world.batteries.forEach(function(b){ cellBox(b.c,b.r,"#3f6212","#a3e635");
      ctx.fillStyle="#ecfccb"; ctx.font="bold 15px sans-serif"; ctx.textAlign="center"; ctx.fillText("⚡", b.c*CELL+CELL/2, b.r*CELL+CELL/2+5); ctx.textAlign="left"; });
    world.hazards.forEach(function(h){ cellBox(h.c,h.r,"#7f1d1d","#f87171");
      ctx.fillStyle="#fecaca"; ctx.font="bold 14px sans-serif"; ctx.textAlign="center"; ctx.fillText("✕", h.c*CELL+CELL/2, h.r*CELL+CELL/2+5); ctx.textAlign="left"; });
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
    // tabs under arena
    document.querySelectorAll(".tab").forEach(function(btn){
      btn.onclick = function(){
        document.querySelectorAll(".tab").forEach(function(b){ b.classList.toggle("active", b===btn); });
        ["events","payload"].forEach(function(name){
          var p = $("panel-"+name); if (p) p.hidden = (name !== btn.getAttribute("data-tab"));
        });
      };
    });
    var copyBtn = $("copyPayloadBtn");
    if (copyBtn) copyBtn.onclick = function(){
      var t = payloadEl.textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ copyBtn.textContent="Copied!"; setTimeout(function(){ copyBtn.textContent="Copy"; },1200); });
    };
    makeDrones();
    spawn(4,"hazards"); spawn(3,"batteries"); spawn(2,"goals"); renderLB();
    var P = window.DroneProviders;
    if(world.drones[0]){ var st=P.buildDroneState(world, world.drones[0]);
      payloadEl.textContent=JSON.stringify(P.payloadPreview(st,world.drones[0].model),null,2); }
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
      if (lp) lp.innerHTML = '<i class="sw goal"></i>landing pad, enter for +'+R.pad+' score';
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
    ["rule-move/move", "rule-hover/hover", "rule-wall/wall", "rule-hazard/hazard", "rule-charge/charge", "rule-pad/pad", "rule-low/low", "rule-maxobs/maxObs", "rule-maxhover/maxHover"].forEach(function(pair){
      var parts = pair.split("/"); bindRule(parts[0], parts[1]);
    });
    var rb = $("rulesResetBtn");
    if (rb) rb.onclick = function(){
      var D = window.DroneProviders.DEFAULT_RULES;
      Object.keys(D).forEach(function(k){ window.DroneProviders.RULES[k] = D[k]; });
      window.DroneProviders.saveRules();
      ["rule-move/move", "rule-hover/hover", "rule-wall/wall", "rule-hazard/hazard", "rule-charge/charge", "rule-pad/pad", "rule-low/low", "rule-maxobs/maxObs", "rule-maxhover/maxHover"].forEach(function(pair){
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
