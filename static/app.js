(() => {
  const app = document.getElementById("app");
  const COLORS = ["#ff4f6d", "#6c4dff", "#19a974", "#ff7a2f", "#3aa0ff", "#b04dff", "#d9a400", "#ff4f9a"];

  let creds = load();          // {code, pid, token}
  let state = null;            // latest server view
  let pollTimer = null;
  let busy = false;
  // Local, per-turn UI state
  let ui = { key: null, selected: null, order: [], scores: {} };

  // ---------- utils ----------
  function load() { try { return JSON.parse(sessionStorage.getItem("tt-creds")); } catch { return null; } }
  function save(c) { creds = c; try { c ? sessionStorage.setItem("tt-creds", JSON.stringify(c)) : sessionStorage.removeItem("tt-creds"); } catch {} }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toastEl = document.getElementById("toast");
  let toastT;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 2600); }
  const colorOf = (pid) => { const i = state ? state.players.findIndex((p) => p.id === pid) : 0; return COLORS[(i < 0 ? 0 : i) % COLORS.length]; };
  const nameOf = (pid) => (state.players.find((p) => p.id === pid) || { name: "?" }).name;
  const avatar = (p) => `<span class="avatar" style="background:${colorOf(p.id)}">${esc(p.name[0].toUpperCase())}</span>`;

  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: "Server error." }));
    if (j.error) throw new Error(j.error);
    return j;
  }
  async function act(type, extra = {}) {
    if (busy) return;
    busy = true;
    try {
      const v = await api("/api/action", { ...creds, type, ...extra });
      setState(v);
    } catch (e) { toast(e.message); } finally { busy = false; }
  }

  // ---------- polling ----------
  async function poll() {
    clearTimeout(pollTimer);
    if (!creds) return;
    try {
      const q = new URLSearchParams({ ...creds, v: state ? state.version : "" });
      const r = await fetch("/api/state?" + q);
      const j = await r.json();
      if (j.gone) { save(null); state = null; toast("That room has ended."); renderHome(); return; }
      if (!j.same) setState(j);
    } catch { /* network blip: try again */ }
    pollTimer = setTimeout(poll, 1000);
  }
  function setState(v) {
    state = v;
    const g = v.game;
    const key = g ? `${g.turn}-${v.phase === "submit" ? "s" : "r"}` : null;
    if (key !== ui.key) ui = { key, selected: null, order: [], scores: {} };
    render();
  }

  // ---------- screens ----------
  function render() {
    if (!state) return renderHome();
    if (state.phase === "lobby") return renderLobby();
    if (state.phase === "over") return renderOver();
    renderGame();
  }

  function renderHome() {
    const urlCode = new URLSearchParams(location.search).get("room") || "";
    app.innerHTML = `
      <div class="wrap"><div class="home stack">
        <div class="center">
          <div class="logo"><span>Taste</span> <span>Test</span></div>
          <div class="tag">How well do you know your friends' favorites?</div>
        </div>
        <div class="panel stack">
          <div><label class="lbl" for="nm">Your name</label>
            <input id="nm" class="field" maxlength="20" placeholder="e.g. Sam" autocomplete="off"></div>
          <button id="create" class="btn block">Create a room</button>
          <div class="divider">or join one</div>
          <div class="row" style="flex-wrap:nowrap">
            <input id="code" class="field code-field" maxlength="4" placeholder="CODE" value="${esc(urlCode)}" autocomplete="off">
            <button id="join" class="btn alt">Join</button>
          </div>
        </div>
        <details class="panel how">
          <summary class="display" style="cursor:pointer;font-size:18px">How to play</summary>
          <div style="margin-top:12px">
            <h3>Classic</h3>
            <p>Everyone holds a hand of 5 cards. Each turn one player is the <b>Chooser</b>. Everyone else secretly plays the card they think the Chooser will <b>love most</b> (or <b>hate most</b>, on flipped turns). The Chooser ranks the cards from worst to best. The best pick earns the most points.</p>
            <h3>Deluxe</h3>
            <p>Each turn draws a category — Places, Foods, Activities, Entertainment, Animals or Things. Players get 3 cards from that category and play one. The Chooser scores every card <b>1–6</b>, with 6 being the most accurate to their taste. That number is your points.</p>
            <h3>Winning</h3>
            <p>Everyone takes a turn as Chooser once per cycle. Play 1 or 2 full cycles — most points wins.</p>
          </div>
        </details>
      </div></div>`;
    const nm = app.querySelector("#nm");
    nm.value = localStorage.getItem("tt-name") || "";
    const go = async (kind) => {
      const name = nm.value.trim();
      if (!name) { nm.focus(); return toast("Enter your name first."); }
      try { localStorage.setItem("tt-name", name); } catch {}
      try {
        const body = kind === "join" ? { name, code: app.querySelector("#code").value } : { name };
        const res = await api("/api/" + kind, body);
        save(res);
        history.replaceState(null, "", "/?room=" + res.code);
        poll();
      } catch (e) { toast(e.message); }
    };
    app.querySelector("#create").onclick = () => go("create");
    app.querySelector("#join").onclick = () => go("join");
    app.querySelector("#code").onkeydown = (e) => { if (e.key === "Enter") go("join"); };
  }

  function seg(id, value, options, disabled) {
    return `<div class="seg" data-seg="${id}">${options.map(([v, label]) =>
      `<button data-v="${v}" class="${String(v) === String(value) ? "on" : ""}" ${disabled ? "disabled" : ""}>${label}</button>`).join("")}</div>`;
  }

  function renderLobby() {
    const s = state.settings, isHost = state.hostId === state.you;
    const n = state.players.length, max = state.limits.max[s.mode], min = state.limits.min;
    const canStart = n >= min && n <= max;
    const link = `${location.origin}/?room=${state.code}`;
    app.innerHTML = `
      <div class="wrap stack">
        <div class="row"><div class="logo" style="font-size:34px"><span>Taste</span> <span>Test</span></div><div class="spacer"></div>
          <button class="btn ghost small" id="leave">Leave</button></div>
        <div class="panel center">
          <div class="muted" style="font-weight:800">ROOM CODE</div>
          <div class="room-code">${state.code}</div>
          <div class="row" style="justify-content:center;margin-top:12px">
            <button class="btn ghost small" id="copy">Copy invite link</button>
          </div>
        </div>
        <div class="lobby-grid">
          <div class="panel">
            <h2 style="margin-bottom:8px">Players <span class="muted">(${n}/${max})</span></h2>
            <ul class="plist">${state.players.map((p) => `
              <li class="${p.online ? "" : "offline"}">${avatar(p)} <span>${esc(p.name)}</span>
                ${p.id === state.hostId ? '<span class="badge host">HOST</span>' : ""}
                ${p.id === state.you ? '<span class="badge">YOU</span>' : ""}
                <span class="spacer"></span>
                ${isHost && p.id !== state.you ? `<button class="btn ghost small" data-kick="${p.id}">Remove</button>` : ""}
              </li>`).join("")}</ul>
            ${n < min ? `<p class="hint">Need at least ${min} players to start.</p>` : ""}
          </div>
          <div class="panel stack">
            <h2>Settings ${isHost ? "" : '<span class="muted" style="font-size:15px">(host picks)</span>'}</h2>
            <div><label class="lbl">Mode</label>
              ${seg("mode", s.mode, [["standard", "Classic"], ["deluxe", "Deluxe"]], !isHost)}
              <div class="hint">${s.mode === "deluxe"
                ? "Category cards. Chooser scores each pick 1–6 (6 = most accurate). Max 7 players."
                : "Hand of 5 cards. Chooser ranks picks from worst to best."}</div></div>
            <div><label class="lbl">Length</label>
              ${seg("cycles", s.cycles, [[1, "1 cycle"], [2, "2 cycles"]], !isHost)}
              <div class="hint">Everyone is the Chooser ${s.cycles === 2 ? "twice" : "once"} — ${n * s.cycles} turns.</div></div>
            <div><label class="lbl">Ranking</label>
              ${seg("direction", s.direction, [["favorite", "Favorites"], ["least", "Least fav"], ["alternate", "Alternate"], ["random", "Random"]], !isHost)}
              <div class="hint">${{
                favorite: "Play what the Chooser would love most.",
                least: "Play what the Chooser would hate most.",
                alternate: "Turns flip between love-it and hate-it.",
                random: "Each turn is randomly love-it or hate-it."
              }[s.direction]}</div></div>
            ${isHost
              ? `<button class="btn block" id="start" ${canStart ? "" : "disabled"}>Start game</button>
                 ${n > max ? `<p class="hint">Too many players for Deluxe (max ${max}).</p>` : ""}`
              : `<p class="muted center" style="font-weight:700">Waiting for the host to start…</p>`}
          </div>
        </div>
      </div>`;
    app.querySelector("#copy").onclick = () => {
      navigator.clipboard?.writeText(link).then(() => toast("Invite link copied!"), () => toast(link));
    };
    app.querySelector("#leave").onclick = leave;
    app.querySelectorAll("[data-kick]").forEach((b) => (b.onclick = () => act("kick", { target: b.dataset.kick })));
    if (isHost) {
      app.querySelectorAll("[data-seg] button").forEach((b) => (b.onclick = () => {
        const key = b.closest("[data-seg]").dataset.seg;
        const val = key === "cycles" ? Number(b.dataset.v) : b.dataset.v;
        act("settings", { settings: { [key]: val } });
      }));
      app.querySelector("#start").onclick = () => act("start");
    }
  }

  async function leave() {
    if (!confirm("Leave this room?")) return;
    try { await api("/api/action", { ...creds, type: "leave" }); } catch {}
    save(null); state = null; clearTimeout(pollTimer);
    history.replaceState(null, "", "/");
    renderHome();
  }

  function cardHTML(card, { tag = "div", attrs = "", extra = "", cls = "" } = {}) {
    const cat = card.cat ? `cat-${card.cat}` : "";
    return `<${tag} class="card ${cat} ${cls}" ${attrs}>
      ${card.cat ? `<span class="cat">${esc(card.cat)}</span>` : ""}
      <span>${esc(card.text)}</span>${extra}</${tag}>`;
  }

  function scoreChips() {
    const g = state.game;
    const order = g.order.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    return `<div class="scores">${order.map((p) => `
      <div class="score-chip ${p.id === g.chooser ? "chooser" : ""} ${p.online ? "" : "offline"}">
        ${avatar(p)}<span>${esc(p.name)}${p.id === state.you ? " (you)" : ""}</span><span class="pts">${p.score}</span>
      </div>`).join("")}</div>`;
  }

  function renderGame() {
    const g = state.game, me = state.you, isChooser = g.chooser === me, isHost = state.hostId === me;
    const deluxe = state.settings.mode === "deluxe";
    const chooserName = esc(nameOf(g.chooser));
    const love = g.prompt === "favorite";
    const verb = love ? "love most" : "hate most";

    let headline, sub;
    if (isChooser) {
      headline = state.phase === "submit" ? "You're the Chooser!" : state.phase === "rank" ? "Time to rank!" : "The results are in";
      sub = love ? "Everyone's trying to guess what you'd love most." : "Everyone's trying to guess what you'd hate most.";
    } else {
      headline = `${chooserName}'s turn`;
      sub = `Play the card ${chooserName} would ${verb}.`;
    }
    const banner = `
      <div class="banner ${love ? "favorite" : "least"}">
        ${g.category ? `<div class="cat-tag">${g.category.emoji} ${esc(g.category.name)}</div>` : ""}
        <h2>${headline}</h2><p>${love ? "❤️" : "💀"} ${sub}</p>
      </div>`;

    let body = "";
    if (state.phase === "submit") body = isChooser ? chooserWaiting() : submitView();
    else if (state.phase === "rank") body = isChooser ? (deluxe ? deluxeRankView(love) : rankView(love)) : spectateRank(chooserName);
    else if (state.phase === "reveal") body = revealView(isHost || isChooser, deluxe);

    const hostTools = isHost && (state.phase === "submit" || state.phase === "rank")
      ? `<div class="actions"><button class="btn ghost small" id="skip">Skip this turn</button></div>` : "";

    app.innerHTML = `
      <div class="wrap">
        <div class="topbar">
          <div class="logo" style="font-size:26px"><span>Taste</span> <span>Test</span></div>
          <span class="pill">${deluxe ? "Deluxe" : "Classic"}</span>
          <span class="pill">Cycle ${g.round}/${state.settings.cycles}</span>
          <span class="pill">Turn ${g.turn}/${g.total}</span>
          <span class="spacer"></span>
          <button class="btn ghost small" id="leave">Leave</button>
        </div>
        ${scoreChips()}
        ${banner}
        ${body}
        ${hostTools}
      </div>`;
    app.querySelector("#leave").onclick = leave;
    const skip = app.querySelector("#skip");
    if (skip) skip.onclick = () => confirm("Skip this turn? No points will be awarded.") && act("skip");
    wireGame();
  }

  function waitingPills() {
    const g = state.game;
    return `<div class="waiting-list">${g.order.filter((id) => id !== g.chooser).map((id) => {
      const done = g.submitted.includes(id);
      return `<span class="pill ${done ? "done" : ""}">${done ? "✓" : "…"} ${esc(nameOf(id))}</span>`;
    }).join("")}</div>`;
  }

  function chooserWaiting() {
    return `<div class="panel center stack">
      <h2>Sit tight 👀</h2>
      <p class="muted" style="font-weight:700;margin:0">Your friends are picking cards for you.</p>
      ${waitingPills()}
    </div>`;
  }

  function submitView() {
    const g = state.game;
    if (g.mine) {
      return `<div class="panel center stack">
        <h2>Card played!</h2>
        <div style="max-width:220px;margin:14px auto">${cardHTML(g.mine)}</div>
        <p class="muted" style="font-weight:700">Waiting on the others…</p>
        ${waitingPills()}
      </div>`;
    }
    return `
      <h3 style="margin:0 0 12px">Your hand — tap a card</h3>
      <div class="cards">${g.hand.map((c) => cardHTML(c, {
        tag: "button", attrs: `data-card="${c.id}"`, cls: ui.selected === c.id ? "selected" : (ui.selected ? "dim" : "")
      })).join("")}</div>
      <div class="actions"><button class="btn" id="play" ${ui.selected ? "" : "disabled"}>Play this card</button></div>`;
  }

  function rankView(love) {
    const g = state.game, n = g.entries.length;
    const done = ui.order.length === n;
    return `
      <div class="panel" style="margin-bottom:16px">
        <b>Start with the worst pick and finish with the best.</b>
        ${love ? "Tap your <b>least favorite</b> first and your <b>favorite</b> last."
               : "Tap the one you'd <b>mind least</b> first and the one you <b>hate most</b> last."}
        <span class="muted">The number on each card is the points it earns. Tap a card again to undo.</span>
      </div>
      <div class="cards">${g.entries.map((e) => {
        const pos = ui.order.indexOf(e.eid);
        return cardHTML(e.card, {
          tag: "button", attrs: `data-rank="${e.eid}"`, cls: pos >= 0 ? "selected" : "",
          extra: pos >= 0 ? `<span class="rank-badge">${pos + 1}</span>` : ""
        });
      }).join("")}</div>
      <div class="actions">
        <button class="btn ghost" id="reset" ${ui.order.length ? "" : "disabled"}>Reset</button>
        <button class="btn" id="lock" ${done ? "" : "disabled"}>Lock in ranking</button>
      </div>`;
  }

  function deluxeRankView(love) {
    const g = state.game;
    const used = new Set(Object.values(ui.scores));
    const done = g.entries.every((e) => ui.scores[e.eid]);
    return `
      <div class="panel" style="margin-bottom:16px">
        <b>Score every card from 1 to 6.</b> 6 = ${love ? "exactly my taste" : "I'd hate this the most"}, 1 = way off.
        <span class="muted">Each score can only be used once.</span>
      </div>
      <div class="cards">${g.entries.map((e) => cardHTML(e.card, {
        cls: ui.scores[e.eid] ? "selected" : "",
        extra: `<div class="scale">${[1, 2, 3, 4, 5, 6].map((v) => {
          const on = ui.scores[e.eid] === v;
          return `<button data-score="${e.eid}" data-v="${v}" class="${on ? "on" : ""}" ${!on && used.has(v) ? "disabled" : ""}>${v}</button>`;
        }).join("")}</div>`
      })).join("")}</div>
      <div class="actions">
        <button class="btn ghost" id="reset" ${used.size ? "" : "disabled"}>Reset</button>
        <button class="btn" id="lock" ${done ? "" : "disabled"}>Lock in scores</button>
      </div>`;
  }

  function spectateRank(chooserName) {
    const g = state.game;
    return `<div class="panel center" style="margin-bottom:16px"><h2>${chooserName} is ranking… 🤔</h2>
      <p class="muted" style="font-weight:700;margin:6px 0 0">Here's what everyone played (anonymous for now).</p></div>
      <div class="cards">${g.entries.map((e) => cardHTML(e.card)).join("")}</div>`;
  }

  function revealView(canAdvance, deluxe) {
    const g = state.game;
    const last = g.turn >= g.total;
    return `
      <div class="results">${g.results.map((r, i) => `
        <div class="result" style="animation-delay:${i * 0.12}s">
          <div class="place">${deluxe ? r.points : "#" + (i + 1)}</div>
          <div class="what"><b>${esc(r.card.text)}</b><span class="muted" style="font-weight:700">played by ${esc(r.name)}${r.pid === state.you ? " (you)" : ""}</span></div>
          <div class="gain">+${r.points}</div>
        </div>`).join("")}</div>
      <div class="actions">${canAdvance
        ? `<button class="btn" id="next">${last ? "See final scores 🏆" : "Next turn →"}</button>`
        : `<p class="muted" style="font-weight:700">Waiting for the host to continue…</p>`}</div>`;
  }

  function wireGame() {
    app.querySelectorAll("[data-card]").forEach((b) => (b.onclick = () => {
      ui.selected = ui.selected === b.dataset.card ? null : b.dataset.card; renderGame();
    }));
    const play = app.querySelector("#play");
    if (play) play.onclick = () => act("submit", { cardId: ui.selected });

    app.querySelectorAll("[data-rank]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.rank, i = ui.order.indexOf(id);
      if (i >= 0) ui.order.splice(i, 1); else ui.order.push(id);
      renderGame();
    }));
    app.querySelectorAll("[data-score]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.score, v = Number(b.dataset.v);
      if (ui.scores[id] === v) delete ui.scores[id]; else ui.scores[id] = v;
      renderGame();
    }));
    const reset = app.querySelector("#reset");
    if (reset) reset.onclick = () => { ui.order = []; ui.scores = {}; renderGame(); };
    const lock = app.querySelector("#lock");
    if (lock) lock.onclick = () => act("rank", state.settings.mode === "deluxe" ? { scores: ui.scores } : { order: ui.order });
    const next = app.querySelector("#next");
    if (next) next.onclick = () => act("next");
  }

  function renderOver() {
    const ranked = [...state.players].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const winners = ranked.filter((p) => p.score === top.score);
    const isHost = state.hostId === state.you;
    const podium = [ranked[1], ranked[0], ranked[2]];
    const heights = [110, 150, 80], labels = ["2", "1", "3"];
    app.innerHTML = `
      <div class="wrap center">
        <div class="logo" style="font-size:34px"><span>Taste</span> <span>Test</span></div>
        <h2 style="font-size:clamp(28px,6vw,44px);margin-top:18px">🏆 ${winners.map((w) => esc(w.name)).join(" & ")} ${winners.length > 1 ? "tie" : "wins"}!</h2>
        <p class="muted" style="font-weight:700">Best at reading everyone's taste with ${top.score} points.</p>
        <div class="podium">${podium.map((p, i) => p ? `
          <div class="step"><div class="nm">${esc(p.name)}</div><div class="sc">${p.score} pts</div>
            <div class="block" style="height:${heights[i]}px;background:${colorOf(p.id)}">${labels[i]}</div></div>` : "").join("")}
        </div>
        <div class="panel" style="max-width:460px;margin:0 auto;text-align:left">
          <ul class="plist">${ranked.map((p, i) => `<li>${i + 1}. ${avatar(p)} ${esc(p.name)}<span class="spacer"></span><b>${p.score}</b></li>`).join("")}</ul>
        </div>
        <div class="actions">
          ${isHost ? `<button class="btn" id="again">Back to lobby</button>` : `<p class="muted" style="font-weight:700">The host can start a new game.</p>`}
          <button class="btn ghost" id="leave">Leave</button>
        </div>
      </div>`;
    const again = app.querySelector("#again");
    if (again) again.onclick = () => act("again");
    app.querySelector("#leave").onclick = leave;
  }

  // ---------- boot ----------
  if (creds) poll(); else renderHome();
})();
