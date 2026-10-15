// Grid providers — single cell per entity. Battleship-style state for System One.
(function () {
  "use strict";
  var MOVES = ["up", "down", "left", "right", "hover"];
  var DELTAS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0], hover:[0,0] };

  // Single source of truth for game economy. Editable via ⚙ Rules panel (no code edits).
  var DEFAULT_RULES = { move: 5, hover: 1, wall: 5, hazard: 10, charge: 30, pad: 50, low: 30, maxObs: 10, maxHover: 3 };
  var RULES = {};
  try {
    var stored = JSON.parse(localStorage.getItem("drone.rules") || "{}");
    RULES = Object.assign({}, DEFAULT_RULES, stored);
  } catch (e) { RULES = Object.assign({}, DEFAULT_RULES); }
  window.DRONE_RULES = RULES;
  window.DRONE_DEFAULT_RULES = DEFAULT_RULES;
  function saveRules() { try { localStorage.setItem("drone.rules", JSON.stringify(RULES)); } catch (e) {} }

  function cellName(c, r) { return String.fromCharCode(65 + c) + (r + 1); }

  function key(c, r) { return c + "," + r; }

  function indexCells(world) {
    var hazards = {}, batteries = {}, goals = {}, drones = {};
    world.hazards.forEach(function(h){ hazards[key(h.c,h.r)] = h; });
    world.batteries.forEach(function(b){ batteries[key(b.c,b.r)] = b; });
    world.goals.forEach(function(g){ goals[key(g.c,g.r)] = g; });
    world.drones.forEach(function(d){ if(!d.dead) drones[key(d.c,d.r)] = d; });
    return { hazards: hazards, batteries: batteries, goals: goals, drones: drones };
  }

  // 2-step gradient: Manhattan steps + compass from a cell to nearest pad/battery.
  // Pure function of (board, cell) — identical math for every model, same tick snapshot.
  function gradient(nc, nr, world) {
    function nearest(list) {
      var best = null;
      (list || []).forEach(function(o){
        var d = Math.abs(o.c - nc) + Math.abs(o.r - nr);
        if (!best || d < best.d) best = { d: d, dx: o.c - nc, dy: o.r - nr };
      });
      return best;
    }
    function code(prefix, b) {
      if (!b) return "";
      if (b.d === 0) return " " + prefix + "-HERE";
      var dir = Math.abs(b.dx) >= Math.abs(b.dy) ? (b.dx > 0 ? "E" : "W") : (b.dy > 0 ? "S" : "N");
      return " " + prefix + b.d + dir;
    }
    return code("P", nearest(world.goals)) + code("B", nearest(world.batteries));
  }
  // Per-drone view: compact ticks-based state. 1 entity = 1 cell.
  // danger = hazards + live rivals merged. Open cells carry a 2-step gradient.
  function buildDroneState(world, drone) {
    var idx = indexCells(world);
    var PADS = (world.goals || []).map(function(g){ return key(g.c, g.r); });
    var isPad = function(k){ return PADS.indexOf(k) !== -1; };
    var criteria = {};
    var dangerCells = [];
    world.hazards.forEach(function(h){ dangerCells.push(cellName(h.c, h.r)); });
    world.drones.forEach(function(d){ if (d !== drone && !d.dead) dangerCells.push(cellName(d.c, d.r)); });
    dangerCells.sort();
    MOVES.forEach(function (m) {
      var nc = drone.c + DELTAS[m][0], nr = drone.r + DELTAS[m][1];
      var k = key(nc, nr);
      if (nc < 0 || nc >= world.cols || nr < 0 || nr >= world.rows) criteria[m] = "WALL";
      else if (m === "hover" && (drone.hoverStreak || 0) >= RULES.maxHover) criteria[m] = cellName(nc, nr) + " HOVER-LIMIT — must move";
      else if (idx.hazards[k]) criteria[m] = cellName(nc, nr) + " DANGER";
      else if (idx.drones[k] && !(nc === drone.c && nr === drone.r)) criteria[m] = cellName(nc, nr) + " DANGER";
      else if (idx.batteries[k]) criteria[m] = cellName(nc, nr) + " BATT";
      else if (isPad(k)) criteria[m] = cellName(nc, nr) + " PAD";
      else criteria[m] = cellName(nc, nr) + " open" + gradient(nc, nr, world);
    });
    var stateObj = {
      me: { at: cellName(drone.c, drone.r), batt: drone.battery },
      pad: (world.goals || []).map(function(g){ return cellName(g.c, g.r); }).sort(),
      batt_cells: (world.batteries || []).map(function(b){ return cellName(b.c, b.r); }).sort(),
      danger: dangerCells,
      tick: world.tick
    };
    return {
      moves: MOVES.slice(),
      instructions: "Get the PAD for +" + RULES.pad + ". Don't enter DANGER. Grab BATT below " + RULES.low +
        ". Move costs " + RULES.move + ", hover costs " + RULES.hover + ", hazard costs " + RULES.hazard +
        ". Max " + RULES.maxHover + " hovers in a row — then you must move." +
        " Codes on open cells: P = steps to pad, B = steps to battery, N/S/E/W = direction (e.g. P3E = pad 3 east).",
      criteria: criteria,
      stateObj: stateObj,
      stateText: "me " + stateObj.me.at + " batt " + stateObj.me.batt +
        " pad " + (stateObj.pad.join(",") || "none") +
        " batt_cells " + (stateObj.batt_cells.join(",") || "none") +
        " danger " + (dangerCells.join(",") || "none") +
        ". " + MOVES.map(function(m){ return m + ":" + criteria[m]; }).join(" ")
    };
  }

  function asciiMap(world, focus) {
    var idx = indexCells(world), rows = [];
    for (var r = 0; r < world.rows; r++) {
      var line = "";
      for (var c = 0; c < world.cols; c++) {
        var k = key(c, r), ch = ".";
        if (idx.hazards[k]) ch = "X";
        else if (idx.batteries[k]) ch = "B";
        else if (idx.goals[k]) ch = "G";
        if (focus && focus.c === c && focus.r === r) ch = "D";
        else if (idx.drones[k]) ch = "R";
        line += ch;
      }
      rows.push(line);
    }
    return "grid (" + world.cols + "x" + world.rows + ", A1 top-left):\n" + rows.join("\n");
  }

  var OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";

  function parseMoveKey(v) {
    var s = String(v == null ? "" : v).toLowerCase();
    for (var i = 0; i < MOVES.length; i++) if (s.indexOf(MOVES[i]) !== -1) return MOVES[i];
    return null;
  }

  // Strip invisible unicode (ZWSP/BOM/NBSP) that breaks fetch headers with
  // "Cannot convert value ... to ByteString ... value 8203". Keeps visible ASCII only.
  function cleanKey(k) {
    return String(k == null ? "" : k).replace(/[^\x20-\x7E]/g, "").trim();
  }

  // Real System One call via OpenRouter Decisions API. Same shape as racer's
  // openrouterDecisionsDecide, swapped from lane_choice to move_choice.
  async function openrouterDecide(droneState, opts) {
    opts = opts || {};
    var apiKey = cleanKey(opts.apiKey);
    if (!apiKey) throw new Error("missing OpenRouter API key");
    var model = (opts.model || "").trim();
    if (!model) throw new Error("missing model");
    var referer = "http://localhost:8080/";
    try {
      if (typeof location !== "undefined" && location.origin && location.origin !== "null") referer = location.origin + "/";
    } catch (e) { /* non-browser */ }
    var t0 = performance.now();
    var res = await fetch(OPENROUTER_DECISIONS, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "SystemOne Drone"
      },
      body: JSON.stringify({
        model: model,
        state: droneState.stateObj,
        questions: { move_choice: { type: "choice", instructions: droneState.instructions, criteria: droneState.criteria } }
      }),
      signal: opts.signal || null
    });
    var latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      var text = "";
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error("openrouter decisions http " + res.status + (text ? ": " + text.slice(0, 200) : ""));
    }
    var json = await res.json();
    var ans = json && json.answers && json.answers.move_choice;
    if (!ans) throw new Error("openrouter decisions: missing move_choice answer");
    if (ans.type && ans.type !== "choice") throw new Error("openrouter decisions: expected choice, got " + ans.type);
    var chosen = parseMoveKey(ans.choice);
    if (!chosen) throw new Error("openrouter decisions: unparsable choice " + ans.choice);
    var probs = ans.probabilities || null;
    if (Array.isArray(probs)) {
      var map = {};
      probs.forEach(function (p) { if (p && typeof p.value === "string") { var m = parseMoveKey(p.value); if (m) map[m] = p.probability; } });
      probs = map;
    }
    return { chosen: chosen, selected: ans.choice, probabilities: probs,
      confidence: typeof ans.confidence === "number" ? ans.confidence : null,
      latencyMs: latencyMs, engine: "openrouter-decisions/" + (json.model || model), raw: json };
  }

  // Live when apiKey present, mock otherwise. Never rejects with dead drone:
  // on live failure, falls back to mock so the arena keeps moving.
  function decideWithFallback(droneState, opts) {
    opts = opts || {};
    if (opts.apiKey) return openrouterDecide(droneState, opts).catch(function (err) {
      return mockDecide(droneState, opts).then(function (m) {
        m.fallback = true; m.liveError = err && err.message || String(err);
        m.engine = m.engine + " (live failed)";
        return m;
      });
    });
    return mockDecide(droneState, opts);
  }

  function mockDecide(droneState, opts) {
    opts = opts || {};
    var t0 = performance.now();
    return new Promise(function (resolve) {
      setTimeout(function () {
        var scores = {}, probs = {};
        droneState.moves.forEach(function (m) {
          var c = droneState.criteria[m], s = Math.random() * 1.2;
          var low = droneState.stateObj.me.batt < RULES.low;
          if (/WALL|DANGER/.test(c)) s -= 5;
          else if (/HOVER-LIMIT/.test(c)) s -= 5;
          else if (/PAD/.test(c)) s += 4;
          else if (/BATT/.test(c)) s += low ? 4 : 1.5;
          else if (/open/.test(c)) s += 0.5;
          if (m === "hover") s += low ? -0.4 : 0.1;
          scores[m] = s;
        });
        var best = Object.keys(scores).sort(function(a,b){ return scores[b]-scores[a]; })[0];
        var exps = {}, sum = 0;
        Object.keys(scores).forEach(function(m){ exps[m] = Math.exp(scores[m]); sum += exps[m]; });
        Object.keys(scores).forEach(function(m){ probs[m] = +(exps[m]/sum).toFixed(3); });
        resolve({ chosen: best, selected: best, probabilities: probs, confidence: probs[best],
          latencyMs: Math.round(performance.now()-t0), engine: "mock-grid/" + (opts.model||"demo"), raw: null });
      }, 80 + Math.random()*300);
    });
  }

  function payloadPreview(droneState, model) {
    return { endpoint: "POST https://openrouter.ai/api/alpha/decisions",
      body: { model: model, state: droneState.stateObj,
        questions: { move_choice: { type:"choice", instructions: droneState.instructions, criteria: droneState.criteria } } } };
  }

  // ---- OpenRouter decisions catalog (ported from systemone-racer) ----
  var OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  var DECISIONS_CATALOG_FALLBACK = [
    { id: "typesafe/jev-1.13", label: "Jev 1.13", vendor: "typesafe", isFree: false },
    { id: "openai/gpt-6-luna-decisions", label: "GPT-6 Luna Decisions", vendor: "openai", isFree: false },
    { id: "microsoft/microsoft-decision-1", label: "Microsoft-Decision-1", vendor: "microsoft", isFree: false }
  ];
  function catalogEntryFromApi(m) {
    var id = m && m.id;
    if (!id || id.charAt(0) === "~") return null;
    var vendor = id.indexOf("/") !== -1 ? id.split("/")[0] : "other";
    var label = ((m.name || id).replace(/^[^:]+:\s*/i, "").trim() || id);
    var pricing = m.pricing || {};
    var free = id.indexOf(":free") !== -1 ||
      (parseFloat(pricing.prompt) === 0 && (parseFloat(pricing.completion) === 0 || isNaN(parseFloat(pricing.completion))));
    return { id: id, label: label, vendor: vendor, isFree: free,
      blurb: String(m.description || "OpenRouter decision model").slice(0, 100).replace(/\s+/g, " ") };
  }
  async function fetchOpenRouterDecisionModels(apiKey) {
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + cleanKey(apiKey);
    var res = await fetch(OPENROUTER_BASE + "/models?output_modalities=decisions", { headers: headers });
    if (!res.ok) return DECISIONS_CATALOG_FALLBACK.slice();
    var json = await res.json();
    var list = (json.data || []).map(catalogEntryFromApi).filter(Boolean);
    if (!list.length) return DECISIONS_CATALOG_FALLBACK.slice();
    list.sort(function (a, b) {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      if (a.vendor !== b.vendor) return a.vendor < b.vendor ? -1 : 1;
      return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
    });
    return list;
  }

  window.DroneProviders = { MOVES: MOVES, DELTAS: DELTAS, cellName: cellName, RULES: RULES,
    DEFAULT_RULES: DEFAULT_RULES, saveRules: saveRules,
    OPENROUTER_DECISIONS: OPENROUTER_DECISIONS, parseMoveKey: parseMoveKey, cleanKey: cleanKey,
    OPENROUTER_BASE: OPENROUTER_BASE, DECISIONS_CATALOG_FALLBACK: DECISIONS_CATALOG_FALLBACK,
    fetchOpenRouterDecisionModels: fetchOpenRouterDecisionModels,
    buildDroneState: buildDroneState, mockDecide: mockDecide, openrouterDecide: openrouterDecide,
    decideWithFallback: decideWithFallback, payloadPreview: payloadPreview, asciiMap: asciiMap };
})();
