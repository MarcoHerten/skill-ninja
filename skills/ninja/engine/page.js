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
// strings together a `ninja on|manual|off --apply …` command from their data
// attributes — the page executes nothing and writes nothing. Bulk execution
// stays in the engine behind `--apply` (two-phase approval: the copy-command
// is the proposal, the CLI run is the approval).
//
// Like `status`, `page` does NOT re-scan the filesystem — it reads
// ~/.skill-ninja/inventory.json (ADR-0003, schema v4). The grouping and
// tagging logic is imported from status.js so the HTML page and the CLI report
// can never diverge: same name grouping, same [linked spread] / [duplicate] /
// [duplicate — same content, other name] tags, same Personal heuristic
// (ADR-0004), same Availability rule (ADR-0014), and scan-root labels. Writes
// exactly one file; reads nothing else from the skill landscape (read-only,
// local-first).

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

function renderSkill(group, store) {
  const tier = groupTier(group.occurrences, store);
  const tierBadge = tier ? ` <span class="tier tier-${tier.toLowerCase()}">${tier}</span>` : "";
  const state = groupAvailability(group);
  const availBadge = availabilityBadge(state);
  const category = group.occurrences.find((o) => o.category)?.category ?? "";
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
    `data-tier="${tier ? tier.toLowerCase() : ""}" data-availability="${state}">\n` +
    `        <summary>\n` +
    `          <input type="checkbox" class="pick" data-name="${escapeHtml(group.name)}" aria-label="select ${escapeHtml(group.name)}">\n` +
    `          <h3>${escapeHtml(group.name)}${tierBadge}${availBadge}${tags.length ? " " + tags.join(" ") : ""}</h3>\n` +
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
// a command line the user copies and runs through the engine (ADR-0011
// amendment).
const COCKPIT_JS = `
(function () {
  "use strict";
  var q = document.getElementById("q");
  var fAvail = document.getElementById("f-avail");
  var fTier = document.getElementById("f-tier");
  var fCat = document.getElementById("f-cat");
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
      var hay = norm(card.getAttribute("data-name") + " " + card.textContent);
      if (hay.indexOf(t) === -1) return false;
    }
    if (fAvail.value !== "all" && card.getAttribute("data-availability") !== fAvail.value) return false;
    if (fTier.value !== "all" && card.getAttribute("data-tier") !== fTier.value) return false;
    if (fCat.value !== "all" && card.getAttribute("data-category") !== fCat.value) return false;
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

  function updateCmd() {
    var names = selected();
    cmd.value = names.length ? "ninja " + state + " --apply " + names.join(" ") : "";
    cmd.placeholder = names.length ? "" : "select skills below, then copy the generated command";
  }

  [q, fAvail, fTier, fCat].forEach(function (el) {
    el.addEventListener("input", applyFilter);
    el.addEventListener("change", applyFilter);
  });

  // Clicking the card checkbox must not toggle the <details> expansion —
  // preventDefault on the summary click handles the label/box pair.
  cards.forEach(function (card) {
    var summary = card.querySelector("summary");
    summary.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("input.pick")) e.preventDefault();
    });
    var box = card.querySelector("input.pick");
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

  applyFilter();
})();
`;

/**
 * Render the cached inventory as one self-contained static HTML document —
 * the HTML counterpart of renderStatus (same grouping, tags, and totals).
 *
 * @param {object} inventory The cached inventory (ADR-0003 schema).
 * @param {{store?:string|null}} config Resolved config (only `store` is used).
 * @returns {string} The HTML document (no trailing newline).
 */
export function renderStatusPage(inventory, config) {
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
            section.skills.map((g) => renderSkill(g, store)).join("") +
            `      </div>\n`,
        )
        .join("")
    : `      <p class="empty">(none)</p>\n`;

  const categoryOptions = sections
    .map((s) => `        <option value="${escapeHtml(s.category)}">${escapeHtml(s.category)}</option>\n`)
    .join("");

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
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1d2430;
    background: #f4f6f8;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { font-size: 19px; margin: 30px 0 10px; padding: 10px 0 8px;
       position: sticky; top: 0; z-index: 2; background: #f4f6f8;
       border-bottom: 1px solid #e3e8ee; }
  .meta { margin: 2px 0; color: #5b6572; font-size: 13.5px; }
  .summary { margin: 14px 0 0; padding: 12px 16px; background: #eef2f6; border-radius: 10px; font-size: 15px; }
  /* The availability cockpit (ADR-0014): search + filters + checkbox bulk
     selection that generates a copyable ninja command. Inline script, still
     no network / server / external assets (ADR-0011 amendment). */
  .controls { margin: 18px 0 0; padding: 14px 16px; background: #fff; border: 1px solid #e3e8ee;
              border-radius: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .controls input[type="search"] { flex: 1 1 220px; padding: 8px 12px; font: inherit;
              border: 1px solid #d4dae2; border-radius: 8px; }
  .controls select { padding: 8px 10px; font: inherit; border: 1px solid #d4dae2; border-radius: 8px;
              background: #fff; max-width: 200px; }
  #count { color: #5b6572; font-size: 13.5px; flex-basis: 100%; }
  .bulk { margin: 10px 0 0; padding: 14px 16px; background: #fff; border: 1px solid #e3e8ee;
          border-radius: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .bulk label { color: #5b6572; font-size: 14px; }
  .bulk button { padding: 7px 14px; font: inherit; font-size: 14px; border: 1px solid #d4dae2;
          border-radius: 8px; background: #f1f4f7; cursor: pointer; }
  .bulk button.state.active { background: #1d2430; color: #fff; border-color: #1d2430; }
  #cmd { flex: 1 1 260px; padding: 8px 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          border: 1px dashed #c3cbd6; border-radius: 8px; background: #fafbfc; color: #1d2430; }
  /* Collapsible skill cards: the summary carries the pick checkbox, name +
     badges + the clamped description, the locations expand on click. */
  details.skill { background: #fff; border: 1px solid #e3e8ee; border-radius: 12px; padding: 0 18px; margin: 10px 0; }
  details.skill > summary { cursor: pointer; list-style: none; padding: 13px 0 11px; }
  details.skill > summary::-webkit-details-marker { display: none; }
  details.skill > summary::before { content: "\\25B8"; color: #98a2b0; display: inline-block; width: 1.2em; }
  details.skill[open] > summary::before { content: "\\25BE"; }
  details.skill > summary h3 { display: inline; margin: 0; font-size: 16.5px; }
  input.pick { margin-right: 10px; transform: translateY(1px); cursor: pointer; }
  .desc { margin: 5px 0 0 1.2em; color: #3d4754; font-size: 14px;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  details.skill[open] .desc { display: block; overflow: visible; }
  .tag { font-size: 12.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .tag-spread { color: #10603e; background: #e2f5ea; }
  .tag-duplicate { color: #8a4b08; background: #fdf0dd; }
  .tag-broken { color: #a11c1c; background: #fbe4e4; }
  .tag-manual { color: #8a4b08; background: #fdf0dd; }
  .tag-off { color: #a11c1c; background: #fbe4e4; }
  .tag-stored { color: #47525f; background: #e8ecf1; }
  .tier { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
          color: #47525f; background: #e8ecf1; padding: 2px 8px; border-radius: 999px; }
  ul.locations { list-style: none; margin: 4px 0 0; padding: 2px 0 12px 1.2em; }
  li.location { padding: 8px 0; border-top: 1px dashed #e6eaf0; }
  .loc-line { font-size: 14.5px; }
  .root { font-weight: 600; }
  code.path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
              background: #f1f4f7; padding: 1px 6px; border-radius: 6px; word-break: break-all; }
  .arrow { color: #5b6572; }
  .loc-meta { color: #5b6572; font-size: 13px; margin-top: 2px; }
  ul.broken { list-style: none; margin: 0; padding: 0; }
  ul.broken li { background: #fff; border: 1px solid #f0d4d4; border-radius: 10px; padding: 10px 14px; margin: 8px 0; }
  .empty { color: #5b6572; font-style: italic; }
  footer { margin-top: 40px; color: #7a8494; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Skill Ninja status</h1>
${generatedAt}    <p class="summary">${escapeHtml(summarySentence(totals))}</p>
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
      </select>
      <select id="f-cat" aria-label="filter by category">
        <option value="all">category: all</option>
${categoryOptions}      </select>
      <span id="count"></span>
    </div>
    <div class="bulk">
      <label><input type="checkbox" id="select-all"> select all shown</label>
      <button class="state" data-state="off">off</button>
      <button class="state" data-state="manual">manual</button>
      <button class="state active" data-state="on">on</button>
      <input id="cmd" readonly placeholder="select skills below, then copy the generated command">
      <button id="copy">Copy</button>
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

  const html = renderStatusPage(inventory, config);
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
