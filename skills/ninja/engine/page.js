// The `page` command: render the cached inventory (written by `init`) as ONE
// self-contained static HTML file — the browser counterpart of `status`
// (SPEC.md user story #41; ADR-0011).
//
// Self-contained means: inline CSS in a <style> block and — per the ADR-0011
// amendment (ADR-0014) — one inline vanilla <script> for the availability
// cockpit; still no external assets or fonts, no network, no server. The file
// opens via file:// and works offline, is written to
// ~/.skill-ninja/status.html, and is regenerated wholesale on every invocation
// (no watcher, no server); the command prints the path.
//
// The script only filters DOM nodes the server-side render produced and
// strings together a `/ninja on|manual|off --apply …` command from their data
// attributes — the page executes nothing and writes nothing. Bulk execution
// stays in the engine behind `--apply` (two-phase approval: the copy-command
// is the proposal, the run — pasted into the agent chat as a slash command,
// or in a terminal without the leading slash — is the approval).
//
// Like `status`, `page` does NOT re-scan the filesystem — it reads
// ~/.skill-ninja/inventory.json (ADR-0003, schema v4). The grouping and
// tagging logic is imported from status.js so the HTML page and the CLI report
// can never diverge: same name grouping, same [linked spread] / [duplicate] /
// [duplicate — same content, other name] tags, same Personal heuristic
// (ADR-0004), same Availability rule (ADR-0014), and scan-root labels. Writes
// exactly one file and reads nothing from the landscape — not even SKILL.md
// bodies: the copy button behind each name copies the NAME (ADR-0011 second
// update 2026-08-19), so the cached inventory is all the page needs.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { groupByCategory, groupDescription, groupTier, resolveVocabulary } from "./cat.js";
import {
  groupSkills,
  groupAvailability,
  availabilityTag,
  plural,
  provenanceSummary,
  scanRootLabel,
  versionLine,
} from "./status.js";
import { collectionsForName, readCollections } from "./collection.js";

const CONFIG_DIR = ".skill-ninja";
const PAGE_FILE = "status.html";

export function statusPagePath(home = homedir()) {
  return join(home, CONFIG_DIR, PAGE_FILE);
}

// Every interpolated value (names, paths, provenance, labels) is data and gets
// escaped — a skill name like `a<b>` must never inject markup.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Same totals the CLI header reports (linked spreads not counted as
// duplicated), plus the Availability totals (ADR-0014) the summary appends
// when non-zero — keeping the classic sentence byte-identical otherwise.
function summarize(groups, broken) {
  return {
    skills: groups.length,
    locations: groups.reduce((n, g) => n + g.occurrences.length, 0),
    duplicated: groups.filter((g) => (g.duplicate && !g.linkedSpread) || g.hashDuplicate).length,
    broken: broken.length,
    manual: groups.filter((g) => groupAvailability(g) === "manual").length,
    off: groups.filter((g) => groupAvailability(g) === "off").length,
  };
}

function summarySentence(s) {
  let sentence =
    `${plural(s.skills, "skill")} across ${plural(s.locations, "location")}, ` +
    `${plural(s.duplicated, "duplicated skill")}, ${plural(s.broken, "broken symlink")}.`;
  if (s.manual > 0 || s.off > 0) {
    sentence += ` ${plural(s.manual, "manual skill")}, ${plural(s.off, "off skill")}.`;
  }
  return sentence;
}

// A skill's Availability badge (ADR-0014): only non-active states get a chip —
// active is the default and must not add noise to a 100+ skill page.
function availabilityBadge(state) {
  if (state === "manual") return ` <span class="tag tag-manual">manual</span>`;
  if (state === "off") return ` <span class="tag tag-off">off</span>`;
  if (state === "stored") return ` <span class="tag tag-stored">stored — not linked</span>`;
  return "";
}

function renderSkill(group, store, collections) {
  const tier = groupTier(group.occurrences, store);
  const tierBadge = tier ? ` <span class="tier tier-${tier.toLowerCase()}">${tier}</span>` : "";
  const state = groupAvailability(group);
  const availBadge = availabilityBadge(state);
  const category = group.occurrences.find((o) => o.category)?.category ?? "";
  const memberships = collectionsForName(group.name, collections).join(",");
  // Tag order mirrors renderStatus: availability, linked spread else duplicate,
  // then the content-hash duplicate.
  const tags = [];
  const availTag = availabilityTag(state);
  if (availTag) tags.push(`<span class="tag">${escapeHtml(availTag)}</span>`);
  if (group.linkedSpread) tags.push(`<span class="tag tag-spread">[linked spread]</span>`);
  else if (group.duplicate) tags.push(`<span class="tag tag-duplicate">[duplicate]</span>`);
  if (group.hashDuplicate) {
    tags.push(`<span class="tag tag-duplicate">[duplicate — same content, other name]</span>`);
  }

  // The full description stays in the markup (findable, copyable); CSS clamps
  // it to two lines in the collapsed summary and shows it fully once expanded.
  const description = groupDescription(group.occurrences);
  const descriptionHtml = description
    ? `        <p class="desc">${escapeHtml(description)}</p>\n`
    : "";

  // The copy button sits directly behind the name (story #54, revised
  // 2026-08-19; slash-prefixed 2026-08-21): one click puts the skill's
  // **chat-ready invocation token** on the clipboard — `/name`, ready to
  // paste into any agent chat to invoke the skill (a terminal run drops the
  // leading slash). It renders from the cached data alone; no file read, no
  // payload to embed.
  const copyButton =
    `<button type="button" class="copy-skill" data-label="copy" ` +
    `aria-label="Copy /${escapeHtml(group.name)}" ` +
    `title="Copy /name — paste into any chat to invoke the skill (a terminal run drops the slash)">copy</button>`;

  const locations = group.occurrences.map((occ) => {
    const link =
      occ.symlink && occ.resolved
        ? ` <span class="arrow">→</span> <code class="path">${escapeHtml(occ.resolved)}</code>`
        : "";
    return (
      `          <li class="location">` +
      `<div class="loc-line"><span class="root">${escapeHtml(scanRootLabel(occ.scanRoot))}</span>` +
      ` — <code class="path">${escapeHtml(occ.dir)}</code>${link}</div>` +
      `<div class="loc-meta">${escapeHtml(versionLine(occ))} | provenance: ${escapeHtml(provenanceSummary(occ))}</div>` +
      `</li>\n`
    );
  });

  return (
    `      <details class="skill" data-name="${escapeHtml(group.name)}" data-category="${escapeHtml(category)}" ` +
    `data-tier="${tier ? tier.toLowerCase() : ""}" data-availability="${state}" data-collections="${escapeHtml(memberships)}">\n` +
    `        <summary>\n` +
    `          <input type="checkbox" class="pick" data-name="${escapeHtml(group.name)}" aria-label="select ${escapeHtml(group.name)}">\n` +
    `          <h3>${escapeHtml(group.name)}${copyButton}${tierBadge}${availBadge}${tags.length ? " " + tags.join(" ") : ""}</h3>\n` +
    descriptionHtml +
    `        </summary>\n` +
    `        <ul class="locations">\n${locations.join("")}        </ul>\n` +
    `      </details>\n`
  );
}

// The availability cockpit's inline script. Plain string concatenation only —
// no template literals, so it can live inside the page's template literal
// unescaped. It reads nothing, fetches nothing, writes nothing: filtering is
// display:none over the server-rendered cards, and the "bulk edit" output is
// a command line the user copies and pastes into the agent chat, where the
// slash form invokes this very skill (ADR-0011 amendment).
const COCKPIT_JS = `
(function () {
  "use strict";
  var q = document.getElementById("q");
  var fAvail = document.getElementById("f-avail");
  var fTier = document.getElementById("f-tier");
  var fCat = document.getElementById("f-cat");
  var fCol = document.getElementById("f-col");
  var count = document.getElementById("count");
  var selectAll = document.getElementById("select-all");
  var cmd = document.getElementById("cmd");
  var cards = Array.prototype.slice.call(document.querySelectorAll("details.skill"));
  var sections = Array.prototype.slice.call(document.querySelectorAll(".cat-section"));
  var state = "off";

  function norm(s) { return (s || "").toLowerCase(); }

  function cardMatches(card) {
    var t = norm(q.value);
    if (t) {
      // The haystack is the rendered card text — name, description,
      // category, locations. Skill bodies are not on the page.
      var hay = norm(card.getAttribute("data-name") + " " + card.textContent);
      if (hay.indexOf(t) === -1) return false;
    }
    if (fAvail.value !== "all" && card.getAttribute("data-availability") !== fAvail.value) return false;
    if (fTier.value !== "all" && card.getAttribute("data-tier") !== fTier.value) return false;
    if (fCat.value !== "all" && card.getAttribute("data-category") !== fCat.value) return false;
    if (fCol && fCol.value !== "all") {
      var mine = (card.getAttribute("data-collections") || "").split(",");
      if (mine.indexOf(fCol.value) === -1) return false;
    }
    return true;
  }

  function applyFilter() {
    var shown = 0;
    cards.forEach(function (card) {
      var vis = cardMatches(card);
      card.style.display = vis ? "" : "none";
      if (vis) shown += 1;
      else { var box = card.querySelector("input.pick"); if (box) box.checked = false; }
    });
    sections.forEach(function (sec) {
      var any = sec.querySelectorAll("details.skill:not([style*='none'])").length > 0;
      sec.style.display = any ? "" : "none";
    });
    count.textContent = shown + " of " + cards.length + " skills shown";
    updateCmd();
  }

  function selected() {
    return cards.filter(function (card) {
      var box = card.querySelector("input.pick");
      return box && box.checked && card.style.display !== "none";
    }).map(function (card) { return card.getAttribute("data-name"); });
  }

  // The command is chat-ready (owner request 2026-08-19): it leads with the
  // /ninja slash form so a paste into the agent chat invokes the skill
  // directly; a terminal run just drops the leading slash.
  function updateCmd() {
    var names = selected();
    cmd.value = names.length ? "/ninja " + state + " --apply " + names.join(" ") : "";
    cmd.placeholder = names.length ? "" : "select skills below, then copy the generated command";
  }

  [q, fAvail, fTier, fCat, fCol].forEach(function (el) {
    if (!el) return;
    el.addEventListener("input", applyFilter);
    el.addEventListener("change", applyFilter);
  });

  // A click on the card checkbox must check the box but not toggle the
  // <details> expansion. Cancelling the summary click is the only way to stop
  // the expansion — but a cancelled click also cancels the checkbox's own
  // activation (the browser reverts the pre-click toggle), so the intended
  // state has to be re-applied once the event has fully completed.
  cards.forEach(function (card) {
    var summary = card.querySelector("summary");
    var box = card.querySelector("input.pick");
    summary.addEventListener("click", function (e) {
      if (!e.target || !e.target.closest || !e.target.closest("input.pick")) return;
      e.preventDefault();
      setTimeout(function () {
        box.checked = !box.checked;
        updateCmd();
      }, 0);
    });
    box.addEventListener("change", updateCmd);
  });

  selectAll.addEventListener("change", function () {
    cards.forEach(function (card) {
      if (card.style.display === "none") return;
      var box = card.querySelector("input.pick");
      if (box) box.checked = selectAll.checked;
    });
    updateCmd();
  });

  Array.prototype.slice.call(document.querySelectorAll("button.state")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      state = btn.getAttribute("data-state");
      Array.prototype.slice.call(document.querySelectorAll("button.state")).forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      updateCmd();
    });
  });

  document.getElementById("copy").addEventListener("click", function () {
    if (!cmd.value) return;
    cmd.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd.value).catch(function () {});
    } else {
      try { document.execCommand("copy"); } catch (e) {}
    }
  });

  // Per-skill name copy (story #54, revised 2026-08-19, slash-prefixed
  // 2026-08-21): the button lives inside <summary>, so its click must not
  // expand the card — cancelling the default action on the same (bubbled)
  // event, the mirror of the pick checkbox workaround above. The payload is
  // the card's data-name with a LEADING SLASH — chat-ready, the same rule
  // the cockpit command got 2026-08-19 evening: a paste into the agent chat
  // invokes the skill directly; a terminal run drops the slash. Clipboard
  // only (no network), with an execCommand fallback for engines without the
  // async API. The label swap is the feedback.
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

  Array.prototype.slice.call(document.querySelectorAll("button.copy-skill")).forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var card = btn.closest("details.skill");
      var name = card ? card.getAttribute("data-name") : "";
      if (!name) return;
      copyToClipboard("/" + name, function (ok) {
        btn.textContent = ok ? "copied ✓" : "copy failed";
        btn.classList.toggle("ok", ok);
        window.setTimeout(function () {
          btn.textContent = btn.getAttribute("data-label") || "copy";
          btn.classList.remove("ok");
        }, 1800);
      });
    });
  });

  applyFilter();
})();
`;

/**
 * Render the cached inventory as one self-contained static HTML document —
 * the HTML counterpart of renderStatus (same grouping, tags, and totals).
 *
 * @param {object} inventory The cached inventory (ADR-0003 schema).
 * @param {{store?:string|null}} config Resolved config (only `store` is used).
 * @param {object} [collections] The store-side collections map (pre-read by
 *   the command, ADR-0017 — render stays synchronous).
 * @returns {string} The HTML document (no trailing newline).
 */
export function renderStatusPage(inventory, config, collections = {}) {
  const store = config?.store ?? null;
  const groups = groupSkills(inventory.skills ?? []);
  const broken = inventory.broken ?? [];
  const totals = summarize(groups, broken);

  const generatedAt = inventory.generatedAt
    ? `  <p class="meta">inventory from ${escapeHtml(inventory.generatedAt)}</p>\n`
    : "";

  // The catalog regrouping (Issue #10): skills render under category headings
  // (vocabulary order, "Uncategorized" last) — the same groupByCategory `cat`
  // uses, so the page and the CLI catalog can never disagree.
  const sections = groupByCategory(groups, resolveVocabulary(config));
  const skillsHtml = sections.length
    ? sections
        .map(
          (section) =>
            `      <div class="cat-section">\n` +
            `      <h2>${escapeHtml(section.category)} (${section.skills.length})</h2>\n` +
            section.skills.map((g) => renderSkill(g, store, collections)).join("") +
            `      </div>\n`,
        )
        .join("")
    : `      <p class="empty">(none)</p>\n`;

  const categoryOptions = sections
    .map((s) => `        <option value="${escapeHtml(s.category)}">${escapeHtml(s.category)}</option>\n`)
    .join("");

  // The collection filter (ADR-0015) — membership is computed server-side
  // (data-collections per card); the cockpit only string-compares.
  const collectionOptions = Object.keys(collections)
    .map((name) => `        <option value="${escapeHtml(name)}">@${escapeHtml(name)}</option>\n`)
    .join("");
  const collectionSelect = collectionOptions
    ? `      <select id="f-col" aria-label="filter by collection">\n` +
      `        <option value="all">collection: all</option>\n` +
      collectionOptions +
      `      </select>\n`
    : "";

  const brokenHtml = broken.length
    ? broken
        .map(
          (b) =>
            `      <li><span class="tag tag-broken">[broken symlink]</span> ` +
            `<code class="path">${escapeHtml(b.path)}</code> — ${escapeHtml(scanRootLabel(b.scanRoot))}</li>\n`,
        )
        .join("")
    : `      <li class="empty">(none)</li>\n`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Ninja status</title>
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
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #0f172a;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .badge-ninja {
    background: #eef2ff;
    color: #4338ca;
    font-size: 12px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .meta { margin: 0; color: #64748b; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .summary {
    margin: 14px 0 0;
    padding: 12px 18px;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    font-size: 14.5px;
    color: #334155;
    font-weight: 500;
  }

  /* Sticky Cockpit Controls */
  .cockpit {
    position: sticky;
    top: 16px;
    z-index: 100;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    padding: 16px 20px;
    margin-bottom: 32px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04);
  }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .controls input[type="search"] {
    flex: 1 1 240px;
    padding: 9px 14px;
    font: inherit;
    font-size: 13.5px;
    color: #0f172a;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    outline: none;
    transition: all 0.15s ease;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .controls input[type="search"]:focus {
    border-color: #4338ca;
    box-shadow: 0 0 0 3px rgba(67, 56, 202, 0.12);
  }
  .controls select {
    padding: 9px 12px;
    font: inherit;
    font-size: 13.5px;
    color: #0f172a;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    outline: none;
    cursor: pointer;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .controls select:focus { border-color: #4338ca; }
  #count { color: #64748b; font-size: 13px; font-weight: 500; margin-left: auto; }

  .bulk {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #e2e8f0;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .bulk label { color: #475569; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .state-toggle { display: inline-flex; background: #f1f5f9; padding: 3px; border-radius: 10px; border: 1px solid #e2e8f0; }
  .bulk button.state {
    padding: 5px 14px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    color: #64748b;
    background: transparent;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .bulk button.state.active { background: #ffffff; color: #4338ca; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
  #cmd {
    flex: 1 1 260px;
    padding: 8px 14px;
    font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #f8fafc;
    border: 1px dashed #cbd5e1;
    border-radius: 10px;
    color: #0f172a;
    outline: none;
  }
  #copy {
    padding: 8px 18px;
    font: inherit;
    font-size: 13.5px;
    font-weight: 600;
    color: #ffffff;
    background: #4338ca;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    transition: all 0.15s ease;
  }
  #copy:hover { background: #3730a3; transform: translateY(-1px); }

  /* Sections */
  .cat-section { margin-bottom: 36px; }
  h2 {
    font-size: 17px;
    font-weight: 700;
    color: #0f172a;
    margin: 0 0 14px;
    padding-bottom: 8px;
    border-bottom: 2px solid #e2e8f0;
  }

  /* Collapsible skill cards */
  details.skill {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    margin-bottom: 10px;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    transition: all 0.2s ease;
  }
  details.skill:hover { border-color: #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
  details.skill[open] { border-color: #4338ca; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
  details.skill > summary { cursor: pointer; list-style: none; padding: 16px 20px; }
  details.skill > summary::-webkit-details-marker { display: none; }
  details.skill > summary::before { content: "\\25B8"; color: #94a3b8; display: inline-block; width: 1.2em; font-size: 14px; }
  details.skill[open] > summary::before { content: "\\25BE"; }
  details.skill > summary h3 { display: inline; margin: 0; font-size: 16px; font-weight: 600; color: #0f172a; }

  input.pick { margin-right: 10px; transform: translateY(1px); cursor: pointer; width: 16px; height: 16px; accent-color: #4338ca; }
  .desc {
    margin: 8px 0 0 2.2em;
    color: #475569;
    font-size: 14px;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  details.skill[open] .desc { display: block; overflow: visible; }

  /* Tags & Badges */
  .tag { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 9999px; white-space: nowrap; }
  .tag-spread { color: #059669; background: #ecfdf5; }
  .tag-duplicate { color: #d97706; background: #fffbeb; }
  .tag-broken { color: #dc2626; background: #fef2f2; }
  .tag-manual { color: #d97706; background: #fffbeb; }
  .tag-off { color: #dc2626; background: #fef2f2; }
  .tag-stored { color: #475569; background: #f1f5f9; }
  .tier {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #4338ca;
    background: #eef2ff;
    padding: 2px 9px;
    border-radius: 9999px;
  }

  /* Copy skill button */
  button.copy-skill {
    margin-left: 8px;
    padding: 3px 10px;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    color: #64748b;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 9999px;
    cursor: pointer;
    vertical-align: 1px;
    transition: all 0.15s ease;
  }
  button.copy-skill:hover { background: #e2e8f0; color: #0f172a; }
  button.copy-skill.ok { color: #059669; background: #ecfdf5; border-color: #a7f3d0; }

  ul.locations {
    list-style: none;
    margin: 0;
    padding: 12px 20px 18px 2.8em;
    border-top: 1px solid #e2e8f0;
    background: #fafafa;
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
  }
  li.location { padding: 8px 0; border-top: 1px dashed #e2e8f0; }
  li.location:first-child { border-top: none; }
  .loc-line { font-size: 13.5px; color: #0f172a; }
  .root { font-weight: 600; }
  code.path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    background: #ffffff;
    color: #334155;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid #e2e8f0;
    word-break: break-all;
  }
  .arrow { color: #64748b; }
  .loc-meta { color: #64748b; font-size: 12.5px; margin-top: 2px; }

  ul.broken { list-style: none; margin: 0; padding: 0; }
  ul.broken li { background: #ffffff; border: 1px solid #fecaca; border-radius: 12px; padding: 12px 18px; margin: 8px 0; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
  .empty { color: #64748b; font-style: italic; }
  footer { margin-top: 60px; text-align: center; color: #64748b; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="header-card">
      <div class="title-row">
        <h1>Skill Ninja status <span class="badge-ninja">Dashboard</span></h1>
      </div>
${generatedAt}      <p class="summary">${escapeHtml(summarySentence(totals))}</p>
    </div>
    <div class="cockpit">
      <div class="controls">
        <input id="q" type="search" placeholder="Search name, description, category…">
        <select id="f-avail" aria-label="filter by availability">
          <option value="all">availability: all</option>
          <option value="active">active</option>
          <option value="manual">manual</option>
          <option value="off">off</option>
          <option value="stored">stored — not linked</option>
        </select>
        <select id="f-tier" aria-label="filter by tier">
          <option value="all">tier: all</option>
          <option value="personal">Personal</option>
          <option value="external">External</option>
          <option value="plugin">Plugin</option>
        </select>
        <select id="f-cat" aria-label="filter by category">
          <option value="all">category: all</option>
${categoryOptions}        </select>
${collectionSelect}        <span id="count"></span>
      </div>
      <div class="bulk">
        <label><input type="checkbox" id="select-all"> select all shown</label>
        <div class="state-toggle">
          <button class="state" data-state="off">off</button>
          <button class="state" data-state="manual">manual</button>
          <button class="state active" data-state="on">on</button>
        </div>
        <input id="cmd" readonly placeholder="select skills below, then copy the generated command">
        <button id="copy">Copy</button>
      </div>
    </div>
  </header>
  <main>
    <section>
${skillsHtml}    </section>
    <section>
      <h2>Broken symlinks</h2>
      <ul class="broken">
${brokenHtml}      </ul>
    </section>
  </main>
  <footer>
    <p>Generated by Skill Ninja from the cached inventory — regenerate with <code>ninja page</code> after <code>ninja init</code>. Self-contained static file; inline script for search/filter only; no server, no external assets, no network.</p>
  </footer>
</div>
<script>
${COCKPIT_JS}</script>
</body>
</html>`;
}

// page — CLI handler. Takes no arguments (the output path is fixed); reads the
// cached inventory (never re-scans), renders, writes, prints the path + totals.
export async function pageCommand(args) {
  for (const a of args) {
    process.stderr.write(`Unknown page argument: ${a}\n`);
    process.stderr.write("Try: ninja page\n");
    return 2;
  }

  const home = homedir();
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      process.stdout.write(
        `No Skill Ninja inventory found at ${inventoryPath(home)}.\n` +
          "Run `ninja init` to scan your skills, then re-run `page`.\n",
      );
      return 0;
    }
    throw err;
  }
  const inventory = JSON.parse(raw);

  // Config feeds the Personal-tier heuristic (the canonical store path); same
  // fallback as `status` when the config has vanished since init.
  let config;
  try {
    config = await loadConfig(home);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      config = { store: null };
    } else {
      throw err;
    }
  }

  const html = renderStatusPage(inventory, config, await readCollections(config));
  const outPath = statusPagePath(home);
  await writeFile(outPath, html + "\n", "utf8");

  const totals = summarize(groupSkills(inventory.skills ?? []), inventory.broken ?? []);
  process.stdout.write(
    `Skill Ninja status page written to ${outPath}\n` +
      `(${summarySentence(totals)})\n` +
      "Self-contained static HTML with an interactive search/filter cockpit — open it in a browser; re-run `ninja page` to refresh.\n",
  );
  return 0;
}
