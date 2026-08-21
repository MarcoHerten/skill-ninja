// The Manager UI page (ADR-0019): one self-contained HTML document served by
// `engine/ui.js` at `/`. Same design language as the static status page (the
// Clean Dashboard template) — but this page is a client of the local server:
// it fetches /api/state and drives the engine through /api/exec, /api/note,
// /api/skill/<name>/raw|prompt and /api/external-remove.
//
// Safety by construction: inventory data (names, paths, descriptions, notes)
// is rendered exclusively through textContent — the markup below is static,
// so a skill name can never inject elements. The two-phase approval model
// survives as an explicit confirm: every mutating button first fetches the
// engine's dry-run and shows its plan; "Ausführen" is the --apply.

const MANAGER_JS = `
(function () {
  "use strict";

  var state = null;

  function $(id) { return document.getElementById(id); }

  // DOM builder — textContent only, data is never markup.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function api(path, body) {
    var opts = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined;
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "HTTP " + res.status);
        return data;
      });
    });
  }

  function showErr(err) { showResult("Fehler", String(err && err.message ? err.message : err)); }

  // ---- clipboard (the page.js pattern: async API, execCommand fallback) ----
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }
  function copyToClipboard(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(fallbackCopy(text)); },
      );
    } else {
      done(fallbackCopy(text));
    }
  }
  function flash(btn, ok) {
    var old = btn.textContent;
    btn.textContent = ok ? "✓" : "✗";
    setTimeout(function () { btn.textContent = old; }, 1400);
  }

  // ---- dialog (the explicit confirm — the click is the --apply) ----
  var dlg = $("dlg"), dlgTitle = $("dlg-title"), dlgPre = $("dlg-pre"),
      dlgOk = $("dlg-ok"), dlgCancel = $("dlg-cancel"), dlgAction = null;
  function openDialog(title, text, okLabel, action) {
    dlgTitle.textContent = title;
    dlgPre.textContent = text;
    dlgOk.textContent = okLabel || "OK";
    dlgAction = action || null;
    dlgCancel.style.display = action ? "" : "none";
    if (!dlg.open) dlg.showModal();
  }
  dlgCancel.addEventListener("click", function () { dlg.close(); });
  dlgOk.addEventListener("click", function () {
    var action = dlgAction;
    dlg.close();
    if (action) action();
  });

  function showResult(title, text) { openDialog(title, text, "OK", null); }

  function runResult(r) {
    if (r.timedOut) return "Zeitüberschreitung — der Lauf wurde abgebrochen.\\n" + r.stdout + r.stderr;
    return (r.code === 0 ? "" : "Exit-Code " + r.code + "\\n") + r.stdout + (r.stderr ? "\\n-- stderr --\\n" + r.stderr : "");
  }

  // ---- engine actions ----
  var MODE_LABELS = { on: "global aktiv", manual: "nur auf Aufruf", off: "aus" };

  function switchAvailability(g, mode) {
    api("/api/exec", { argv: [mode, g.name] }).then(function (dry) {
      if (dry.code !== 0) { showResult("Engine lehnt ab", runResult(dry)); return; }
      openDialog(
        "'" + g.name + "' → " + MODE_LABELS[mode] + " (Plan)",
        dry.stdout + "\\n\\nAusführen? (Availability greift in NEUEN Agent-Sitzungen.)",
        "Ausführen",
        function () {
          api("/api/exec", { argv: [mode, g.name, "--apply"] }).then(function (app) {
            showResult("Ausgeführt", runResult(app));
            loadState();
          }, showErr);
        },
      );
    }, showErr);
  }

  // External removal (ADR-0020): exactly two actions — leave or remove,
  // delegated to skills.sh. Scope from the occurrences: a skill that only
  // lives under project scan roots is removed there; anything else globally.
  function removeExternalFlow(g) {
    var projectLoc = null;
    for (var i = 0; i < g.locations.length; i++) {
      if (g.locations[i].kind === "project") { projectLoc = g.locations[i]; break; }
    }
    var req = projectLoc
      ? { name: g.name, scope: "project", projectDir: projectLoc.dir }
      : { name: g.name, scope: "global" };
    var where = projectLoc ? "im Projekt " + projectLoc.dir : "global (~)";
    openDialog(
      "'" + g.name + "' entfernen (skills.sh)",
      "Der External-Skill wird über skills.sh entfernt (" + where + ") —\\n" +
        "Skill Ninja löscht nichts selbst; das Lockfile bleibt konsistent (ADR-0020).\\n\\n" +
        "skills remove " + g.name + (projectLoc ? "" : " -g") + " -y",
      "Entfernen",
      function () {
        api("/api/external-remove", req).then(function (r) {
          showResult("skills.sh-Bericht", runResult(r));
          loadState();
        }, showErr);
      },
    );
  }

  // ---- copy flavors (Name / SKILL.md / Chat-Prompt) ----
  function copyName(btn, g) { copyToClipboard(g.name, function (ok) { flash(btn, ok); }); }
  function copyRaw(btn, g) {
    api("/api/skill/" + encodeURIComponent(g.name) + "/raw").then(function (data) {
      copyToClipboard(data.text, function (ok) { flash(btn, ok); });
    }, showErr);
  }
  function copyPrompt(btn, g) {
    api("/api/skill/" + encodeURIComponent(g.name) + "/prompt").then(function (data) {
      copyToClipboard(data.text, function (ok) { flash(btn, ok); });
    }, showErr);
  }

  // ---- notes ----
  function saveNote(btn, statusSpan, g, textarea) {
    api("/api/note", { name: g.name, text: textarea.value }).then(function (r) {
      g.note = textarea.value;
      statusSpan.textContent = r.deleted
        ? "Notiz gelöscht"
        : "Gespeichert" + (r.committed ? " · Commit im Store" : " · gespeichert (Store ohne git)");
    }, showErr);
  }

  // ---- card rendering ----
  var AVAIL_LABELS = { active: "aktiv", manual: "nur auf Aufruf", off: "aus", stored: "gespeichert — nicht verlinkt" };

  function availabilityBadge(g) {
    if (g.availability === "active") return null;
    return el("span", "tag tag-" + g.availability, AVAIL_LABELS[g.availability] || g.availability);
  }

  function copyButtons(g) {
    var frag = document.createDocumentFragment();
    var defs = [
      ["Name", copyName], ["SKILL.md", copyRaw], ["Chat-Prompt", copyPrompt],
    ];
    defs.forEach(function (d) {
      var b = el("button", "copy-skill", d[0]);
      b.type = "button";
      b.title = d[0] + " in die Zwischenablage kopieren";
      b.addEventListener("click", function (e) { e.preventDefault(); d[1](b, g); });
      frag.appendChild(b);
    });
    return frag;
  }

  function noteBlock(g) {
    var wrap = el("div", "note-block");
    wrap.appendChild(el("label", null, "Notiz — warum ist dieser Skill für mich relevant?"));
    var ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = g.note || "";
    ta.placeholder = "z.B. 'Marketing-Set: YouTube-Recherche für Landingpages'";
    var status = el("span", "note-status", "");
    var save = el("button", "mini", "Speichern");
    save.type = "button";
    save.addEventListener("click", function () { saveNote(save, status, g, ta); });
    wrap.appendChild(ta);
    var row = el("div", "note-row");
    row.appendChild(save);
    row.appendChild(status);
    wrap.appendChild(row);
    return wrap;
  }

  function actionRow(g) {
    var row = el("div", "actions");
    if (g.name === "ninja") {
      row.appendChild(el("span", "hint", "Skill Ninja selbst bleibt immer verfügbar."));
      return row;
    }
    if (g.tier === "personal") {
      var seg = el("div", "state-toggle");
      [["on", "Global aktiv"], ["manual", "Nur auf Aufruf"], ["off", "Aus"]].forEach(function (d) {
        var b = el("button", "state", d[1]);
        b.type = "button";
        var current = g.availability === "active" ? "on" : g.availability;
        if (current === d[0]) { b.classList.add("active"); b.disabled = true; }
        else b.addEventListener("click", function () { switchAvailability(g, d[0]); });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      return row;
    }
    if (g.tier === "external") {
      var b = el("button", "state danger", "Über skills.sh entfernen …");
      b.type = "button";
      b.addEventListener("click", function () { removeExternalFlow(g); });
      row.appendChild(b);
      row.appendChild(el("span", "hint", "Nur belassen oder entfernen — kein 'Nur auf Aufruf' für skills.sh-Skills (ADR-0020)."));
      return row;
    }
    if (g.tier === "plugin") {
      row.appendChild(el("span", "hint", "Plugin-owned — über das Plugin-System des Agents verwalten (ADR-0018)."));
      return row;
    }
    row.appendChild(el("span", "hint", "Kein Store-Zugriff — erst 'ninja add' oder 'ninja doctor', dann schaltbar."));
    return row;
  }

  function cardNode(g) {
    var card = el("details", "skill");
    card.dataset.name = g.name;
    card.dataset.tier = g.tier;
    card.dataset.availability = g.availability;
    card.dataset.category = g.category;
    card.dataset.collections = (g.collections || []).join(",");

    var summary = el("summary");
    var h3 = el("h3", null, g.name);
    h3.appendChild(copyButtons(g));
    if (g.tier) h3.appendChild(el("span", "tier tier-" + g.tier, g.tier === "personal" ? "Personal" : g.tier === "external" ? "External" : "Plugin"));
    var avail = availabilityBadge(g);
    if (avail) h3.appendChild(avail);
    if (g.linkedSpread) h3.appendChild(el("span", "tag tag-spread", "[linked spread]"));
    else if (g.duplicate) h3.appendChild(el("span", "tag tag-duplicate", "[duplicate]"));
    if (g.hashDuplicate) h3.appendChild(el("span", "tag tag-duplicate", "[Inhalt bereits unter anderem Namen]"));
    summary.appendChild(h3);
    if (g.description) summary.appendChild(el("p", "desc", g.description));
    card.appendChild(summary);

    var body = el("div", "card-body");
    var ul = el("ul", "locations");
    g.locations.forEach(function (loc) {
      var li = el("li", "location");
      var line = el("div", "loc-line");
      line.appendChild(el("span", "root", loc.label));
      line.appendChild(document.createTextNode(" — "));
      var code = el("code", "path", loc.dir);
      line.appendChild(code);
      if (loc.resolved) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(el("span", "arrow", "→"));
        line.appendChild(document.createTextNode(" " + loc.resolved));
      }
      li.appendChild(line);
      ul.appendChild(li);
    });
    body.appendChild(ul);
    if (g.tier === "personal") body.appendChild(noteBlock(g));
    body.appendChild(actionRow(g));
    card.appendChild(body);
    return card;
  }

  // ---- sections + filters ----
  function sectionsOf(groups) {
    var byCat = {};
    groups.forEach(function (g) {
      var c = g.category || "Uncategorized";
      (byCat[c] = byCat[c] || []).push(g);
    });
    return Object.keys(byCat)
      .sort(function (a, b) {
        if (a === "Uncategorized") return 1;
        if (b === "Uncategorized") return -1;
        return a.localeCompare(b);
      })
      .map(function (c) {
        return { category: c, skills: byCat[c].sort(function (a, b) { return a.name.localeCompare(b.name); }) };
      });
  }

  function fillSelect(select, values, allLabel) {
    while (select.options.length > 1) select.remove(1);
    values.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    });
    select.options[0].textContent = allLabel;
  }

  function applyFilter() {
    if (!state || !state.ready) return;
    var q = $("q").value.toLowerCase();
    var fAvail = $("f-avail").value, fTier = $("f-tier").value,
        fCat = $("f-cat").value, fCol = $("f-col").value;
    var cards = Array.prototype.slice.call(document.querySelectorAll("details.skill"));
    var sections = Array.prototype.slice.call(document.querySelectorAll(".cat-section"));
    var shown = 0;
    cards.forEach(function (card) {
      var ok = true;
      if (q) {
        var hay = (card.dataset.name + " " + card.textContent).toLowerCase();
        if (hay.indexOf(q) === -1) ok = false;
      }
      if (ok && fAvail !== "all" && card.dataset.availability !== fAvail) ok = false;
      if (ok && fTier !== "all" && card.dataset.tier !== fTier) ok = false;
      if (ok && fCat !== "all" && card.dataset.category !== fCat) ok = false;
      if (ok && fCol !== "all" && (card.dataset.collections || "").split(",").indexOf(fCol) === -1) ok = false;
      card.style.display = ok ? "" : "none";
      if (ok) shown += 1;
    });
    sections.forEach(function (sec) {
      var any = sec.querySelectorAll("details.skill:not([style*='none'])").length > 0;
      sec.style.display = any ? "" : "none";
    });
    $("count").textContent = shown + " von " + cards.length + " Skills sichtbar";
  }

  // ---- top-level render ----
  function renderAll() {
    var meta = $("meta"), summary = $("summary-line"), cardsHost = $("cards");
    cardsHost.textContent = "";
    if (!state.ready) {
      meta.textContent = "";
      summary.textContent = "";
      var empty = el("p", "empty", "Kein Inventar gefunden — zuerst scannen lassen (ninja init).");
      var init = el("button", "primary", "Jetzt scannen (init)");
      init.type = "button";
      init.addEventListener("click", refresh);
      var wrap = el("div");
      wrap.appendChild(empty);
      wrap.appendChild(init);
      cardsHost.appendChild(wrap);
      return;
    }
    meta.textContent = state.generatedAt ? "Inventar von " + state.generatedAt : "";
    var s = state.summary;
    summary.textContent =
      s.skills + " Skills · " + s.locations + " Orte · " +
      s.active + " aktiv · " + s.manual + " nur auf Aufruf · " + s.off + " aus · " + s.stored + " gespeichert";

    fillSelect($("f-cat"), uniqueCategories(), "Kategorie: alle");
    fillSelect($("f-col"), Object.keys(state.collections || {}).sort(), "Collection: alle");

    sectionsOf(state.groups).forEach(function (section) {
      var div = el("div", "cat-section");
      div.appendChild(el("h2", null, section.category + " (" + section.skills.length + ")"));
      section.skills.forEach(function (g) { div.appendChild(cardNode(g)); });
      cardsHost.appendChild(div);
    });
    applyFilter();
  }

  function uniqueCategories() {
    var seen = {};
    (state.groups || []).forEach(function (g) { seen[g.category || "Uncategorized"] = true; });
    return Object.keys(seen).sort();
  }

  function loadState() {
    return api("/api/state").then(function (s) {
      state = s;
      renderAll();
      renderProfiles();
    }, showErr);
  }

  function refresh() {
    api("/api/exec", { argv: ["init"] }).then(function (r) {
      showResult("Scan (init)", runResult(r));
      loadState();
    }, showErr);
  }

  // ---- profiles panel ----
  function selectedProjectDir() {
    var picked = $("project-select").value;
    if (picked) return picked;
    var free = $("project-free").value.trim();
    return free || null;
  }

  function renderProfiles() {
    var sel = $("profile-select");
    while (sel.options.length > 1) sel.remove(1);
    var names = Object.keys((state && state.profiles) || {}).sort();
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n;
      o.textContent = n + " (" + state.profiles[n].length + " Skills)";
      sel.appendChild(o);
    });
    var pSel = $("project-select");
    while (pSel.options.length > 1) pSel.remove(1);
    ((state && state.config && state.config.projects) || []).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      pSel.appendChild(o);
    });
  }

  function profileAction(sub) {
    var name = $("profile-select").value;
    if (!name) { showResult("Profil", "Bitte zuerst ein Profil wählen."); return; }
    var dir = selectedProjectDir();
    if (!dir || dir.indexOf("/") !== 0) { showResult("Profil", "Bitte ein Projektverzeichnis wählen oder einen absoluten Pfad eintragen."); return; }
    var members = state.profiles[name];
    openDialog(
      "Profil '" + name + "' " + (sub === "apply" ? "anwenden" : "liften"),
      (sub === "apply"
        ? members.length + " Skill-Links in " + dir + "/.agents/skills anlegen (additiv zur globalen Baseline)."
        : "Die Links dieses Profils in " + dir + " entfernen.") +
        "\\n\\nMitglieder: " + members.join(", "),
      sub === "apply" ? "Anwenden" : "Liften",
      function () {
        api("/api/exec", { argv: ["profile", sub, name], cwd: dir }).then(function (r) {
          showResult("ninja profile " + sub, runResult(r));
          loadState();
        }, showErr);
      },
    );
  }

  // ---- bulk migration (⑤): every own ACTIVE skill → Manual, with preview ----
  function bulkManual() {
    if (!state || !state.ready) return;
    var personal = state.groups.filter(function (g) { return g.tier === "personal"; });
    var actives = personal.filter(function (g) { return g.availability === "active"; });
    var except = personal.filter(function (g) { return g.availability !== "active"; }).map(function (g) { return g.name; });
    if (actives.length === 0) {
      showResult("Nichts zu tun", "Keine eigenen Skills im Zustand 'aktiv' — alles bereits auf 'nur auf Aufruf' oder 'aus'.");
      return;
    }
    var argv = ["manual", "--tier", "personal"];
    if (except.length) argv.push("--except", except.join(","));
    api("/api/exec", { argv: argv }).then(function (dry) {
      if (dry.code !== 0) { showResult("Engine lehnt ab", runResult(dry)); return; }
      openDialog(
        actives.length + " eigene aktive Skills → 'Nur auf Aufruf' (Plan)",
        dry.stdout + "\\n\\nAusführen? Das leert die Auto-Trigger deiner Skills — Aufruf bleibt jederzeit explizit möglich.",
        "Ausführen",
        function () {
          api("/api/exec", { argv: argv.concat(["--apply"]) }).then(function (app) {
            showResult("Ausgeführt", runResult(app));
            loadState();
          }, showErr);
        },
      );
    }, showErr);
  }

  // ---- wiring ----
  ["q", "f-avail", "f-tier", "f-cat", "f-col"].forEach(function (id) {
    var n = $(id);
    n.addEventListener("input", applyFilter);
    n.addEventListener("change", applyFilter);
  });
  $("refresh").addEventListener("click", refresh);
  $("bulk-manual").addEventListener("click", bulkManual);
  $("profile-apply").addEventListener("click", function () { profileAction("apply"); });
  $("profile-lift").addEventListener("click", function () { profileAction("lift"); });

  loadState();
})();
`;

/**
 * Render the Manager UI page — a static, self-contained document (inline CSS
 * and script, no external assets) that talks to the local server's API.
 * @returns {string}
 */
export function renderManagerPage() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Ninja Manager</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14.5px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #0f172a;
    background: #f8fafc;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }

  header { margin-bottom: 24px; }
  .header-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    padding: 24px 28px;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    margin-bottom: 24px;
  }
  .title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px; }
  h1 {
    margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: #0f172a;
    display: flex; align-items: center; gap: 10px;
  }
  .badge-ninja {
    background: #eef2ff; color: #4338ca; font-size: 12px; font-weight: 700; padding: 3px 10px;
    border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .meta { margin: 0 0 4px; color: #64748b; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .summary { margin: 14px 0 0; padding: 12px 18px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 12px; font-size: 14.5px; color: #334155; font-weight: 500; }
  button.primary {
    padding: 8px 18px; font: inherit; font-size: 13.5px; font-weight: 600; color: #ffffff;
    background: #4338ca; border: none; border-radius: 10px; cursor: pointer;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); transition: all 0.15s ease;
  }
  button.primary:hover { background: #3730a3; }

  /* Sticky toolbar */
  .cockpit {
    position: sticky; top: 16px; z-index: 100;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid #e2e8f0; border-radius: 16px; padding: 16px 20px; margin-bottom: 24px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04);
  }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .controls input[type="search"] {
    flex: 1 1 240px; padding: 9px 14px; font: inherit; font-size: 13.5px; color: #0f172a;
    background: #ffffff; border: 1px solid #cbd5e1; border-radius: 10px; outline: none;
    transition: all 0.15s ease; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .controls input[type="search"]:focus { border-color: #4338ca; box-shadow: 0 0 0 3px rgba(67, 56, 202, 0.12); }
  .controls select {
    padding: 9px 12px; font: inherit; font-size: 13.5px; color: #0f172a; background: #ffffff;
    border: 1px solid #cbd5e1; border-radius: 10px; outline: none; cursor: pointer;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .controls select:focus { border-color: #4338ca; }
  #count { color: #64748b; font-size: 13px; font-weight: 500; margin-left: auto; }
  .bulk {
    margin-top: 14px; padding-top: 14px; border-top: 1px solid #e2e8f0;
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  }

  /* Profiles panel */
  .panel {
    background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 16px 20px;
    margin-bottom: 24px; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .panel h2 { margin: 0 0 10px; font-size: 15px; font-weight: 700; }
  .panel .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .panel select, .panel input[type="text"] {
    padding: 8px 12px; font: inherit; font-size: 13.5px; color: #0f172a; background: #ffffff;
    border: 1px solid #cbd5e1; border-radius: 10px; outline: none;
  }
  .panel input[type="text"] { flex: 1 1 220px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .panel .hint { color: #64748b; font-size: 12.5px; }
  button.mini {
    padding: 6px 14px; font: inherit; font-size: 13px; font-weight: 600; color: #4338ca;
    background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px; cursor: pointer;
  }
  button.mini:hover { background: #e0e7ff; }

  /* Sections + cards */
  .cat-section { margin-bottom: 36px; }
  h2.section {
    font-size: 17px; font-weight: 700; color: #0f172a; margin: 0 0 14px; padding-bottom: 8px;
    border-bottom: 2px solid #e2e8f0;
  }
  details.skill {
    background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 10px;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); transition: all 0.2s ease;
  }
  details.skill:hover { border-color: #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
  details.skill[open] { border-color: #4338ca; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
  details.skill > summary { cursor: pointer; list-style: none; padding: 16px 20px; }
  details.skill > summary::-webkit-details-marker { display: none; }
  details.skill > summary::before { content: "\\25B8"; color: #94a3b8; display: inline-block; width: 1.2em; font-size: 14px; }
  details.skill[open] > summary::before { content: "\\25BE"; }
  details.skill > summary h3 { display: inline; margin: 0; font-size: 16px; font-weight: 600; color: #0f172a; }
  .desc {
    margin: 8px 0 0 2.2em; color: #475569; font-size: 14px; line-height: 1.5;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  }
  details.skill[open] .desc { display: block; overflow: visible; }

  .tag { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 9999px; white-space: nowrap; }
  .tag-spread { color: #059669; background: #ecfdf5; }
  .tag-duplicate { color: #d97706; background: #fffbeb; }
  .tag-manual { color: #d97706; background: #fffbeb; }
  .tag-off { color: #dc2626; background: #fef2f2; }
  .tag-stored { color: #475569; background: #f1f5f9; }
  .tier {
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: #4338ca; background: #eef2ff; padding: 2px 9px; border-radius: 9999px;
  }
  .tier-external { color: #0891b2; background: #ecfeff; }
  .tier-plugin { color: #64748b; background: #f1f5f9; }

  button.copy-skill {
    margin-left: 6px; padding: 3px 10px; font-family: inherit; font-size: 11.5px; font-weight: 600;
    color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 9999px;
    cursor: pointer; vertical-align: 1px; transition: all 0.15s ease;
  }
  button.copy-skill:hover { background: #e2e8f0; color: #0f172a; }

  .card-body { border-top: 1px solid #e2e8f0; padding: 12px 20px 18px 2.8em; background: #fafafa; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; }
  ul.locations { list-style: none; margin: 0 0 12px; padding: 0; }
  li.location { padding: 6px 0; border-top: 1px dashed #e2e8f0; font-size: 13.5px; }
  li.location:first-child { border-top: none; }
  code.path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
    background: #ffffff; color: #334155; padding: 2px 8px; border-radius: 6px; border: 1px solid #e2e8f0;
    word-break: break-all;
  }
  .arrow { color: #64748b; }

  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
  .state-toggle { display: inline-flex; background: #f1f5f9; padding: 3px; border-radius: 10px; border: 1px solid #e2e8f0; gap: 2px; }
  .state-toggle button.state {
    padding: 5px 14px; font: inherit; font-size: 13px; font-weight: 600; color: #64748b;
    background: transparent; border: none; border-radius: 7px; cursor: pointer; transition: all 0.15s ease;
  }
  .state-toggle button.state.active { background: #ffffff; color: #4338ca; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
  .state-toggle button.state.active { cursor: default; }
  button.state.danger {
    padding: 5px 14px; font: inherit; font-size: 13px; font-weight: 600; color: #b91c1c;
    background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; cursor: pointer;
  }
  button.state.danger:hover { background: #fee2e2; }
  .hint { color: #64748b; font-size: 12.5px; }

  .note-block { margin-top: 12px; }
  .note-block label { display: block; font-size: 12.5px; font-weight: 600; color: #475569; margin-bottom: 6px; }
  .note-block textarea {
    width: 100%; padding: 8px 12px; font: inherit; font-size: 13.5px; color: #0f172a;
    background: #ffffff; border: 1px solid #cbd5e1; border-radius: 10px; outline: none; resize: vertical;
  }
  .note-block textarea:focus { border-color: #4338ca; }
  .note-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .note-status { color: #059669; font-size: 12.5px; }

  .empty { color: #64748b; font-style: italic; margin: 0 0 10px; }
  footer { margin-top: 60px; text-align: center; color: #64748b; font-size: 13px; }

  dialog {
    border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px 28px; max-width: 720px; width: 90vw;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }
  dialog::backdrop { background: rgba(15, 23, 42, 0.4); }
  dialog h3 { margin: 0 0 12px; font-size: 16px; }
  dialog pre {
    margin: 0 0 18px; padding: 14px 16px; background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 10px; font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 55vh; overflow: auto;
  }
  .dlg-row { display: flex; justify-content: flex-end; gap: 10px; }
  .dlg-row button {
    padding: 8px 18px; font: inherit; font-size: 13.5px; font-weight: 600; border-radius: 10px; cursor: pointer;
    border: 1px solid #cbd5e1; background: #ffffff; color: #334155;
  }
  .dlg-row button#dlg-ok { background: #4338ca; border-color: #4338ca; color: #ffffff; }
  .dlg-row button#dlg-ok:hover { background: #3730a3; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="header-card">
      <div class="title-row">
        <h1>Skill Ninja Manager <span class="badge-ninja">Manager UI</span></h1>
        <button id="refresh" class="primary" type="button">Neu scannen (init)</button>
      </div>
      <p class="meta" id="meta"></p>
      <p class="summary" id="summary-line"></p>
    </div>
    <div class="cockpit">
      <div class="controls">
        <input id="q" type="search" placeholder="Suche Name, Beschreibung, Kategorie …">
        <select id="f-avail" aria-label="nach Verfügbarkeit filtern">
          <option value="all">Verfügbarkeit: alle</option>
          <option value="active">aktiv</option>
          <option value="manual">nur auf Aufruf</option>
          <option value="off">aus</option>
          <option value="stored">gespeichert — nicht verlinkt</option>
        </select>
        <select id="f-tier" aria-label="nach Tier filtern">
          <option value="all">Tier: alle</option>
          <option value="personal">Personal</option>
          <option value="external">External</option>
          <option value="plugin">Plugin</option>
        </select>
        <select id="f-cat" aria-label="nach Kategorie filtern">
          <option value="all">Kategorie: alle</option>
        </select>
        <select id="f-col" aria-label="nach Collection filtern">
          <option value="all">Collection: alle</option>
        </select>
        <span id="count"></span>
      </div>
      <div class="bulk">
        <button id="bulk-manual" class="mini" type="button">Alle eigenen aktiven Skills → „Nur auf Aufruf“ …</button>
        <span class="hint">Die Einmal-Migration gegen das volle Kontextfenster (mit Vorschau).</span>
      </div>
    </div>
    <div class="panel">
      <h2>Profile — Projekt-Installation über Skill-Sets</h2>
      <div class="row">
        <select id="profile-select" aria-label="Profil wählen">
          <option value="">Profil wählen …</option>
        </select>
        <select id="project-select" aria-label="Projektverzeichnis wählen">
          <option value="">Projekt …</option>
        </select>
        <input id="project-free" type="text" placeholder="…oder absoluter Projektpfad (/Users/…)">
        <button id="profile-apply" class="mini" type="button">In Projekt anwenden</button>
        <button id="profile-lift" class="mini" type="button">Liften</button>
      </div>
      <p class="hint" style="margin: 10px 0 0;">Anwenden verlinkt die Profil-Mitglieder additiv in &lt;Projekt&gt;/.agents/skills — das Projekt entscheidet, welche Skills dort leben.</p>
    </div>
  </header>
  <main id="cards"></main>
  <footer>
    <p>Manager UI (ADR-0019) — läuft lokal auf 127.0.0.1, liest das Inventar aus dem Cache, jeder Schreibvorgang fragt zuerst. Ctrl-C im Terminal beendet den Server.</p>
  </footer>
</div>
<dialog id="dlg">
  <h3 id="dlg-title"></h3>
  <pre id="dlg-pre"></pre>
  <div class="dlg-row">
    <button id="dlg-cancel" type="button">Abbrechen</button>
    <button id="dlg-ok" type="button">OK</button>
  </div>
</dialog>
<script>
${MANAGER_JS}</script>
</body>
</html>`;
}
