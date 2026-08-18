// The `page` command: render the cached inventory (written by `init`) as ONE
// self-contained static HTML file — the browser counterpart of `status`
// (SPEC.md user story #41; ADR-0011).
//
// Self-contained means: inline CSS in a <style> block, no scripts, no external
// assets or fonts, no network — the file opens via file:// and works offline.
// It is written to ~/.skill-ninja/status.html and regenerated wholesale on
// every invocation (no watcher, no server); the command prints the path.
//
// Like `status`, `page` does NOT re-scan the filesystem — it reads
// ~/.skill-ninja/inventory.json (ADR-0003, schema v2). The grouping and
// tagging logic is imported from status.js so the HTML page and the CLI report
// can never diverge: same name grouping, same [linked spread] / [duplicate] /
// [duplicate — same content, other name] tags, same Personal heuristic
// (ADR-0004) and scan-root labels. Writes exactly one file; reads nothing else
// from the skill landscape (read-only, local-first).

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { groupByCategory, groupDescription, groupTier, DEFAULT_CATEGORIES } from "./cat.js";
import {
  groupSkills,
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

// Same totals the CLI header reports (linked spreads not counted as duplicated).
function summarize(groups, broken) {
  return {
    skills: groups.length,
    locations: groups.reduce((n, g) => n + g.occurrences.length, 0),
    duplicated: groups.filter((g) => (g.duplicate && !g.linkedSpread) || g.hashDuplicate).length,
    broken: broken.length,
  };
}

function summarySentence(s) {
  return (
    `${plural(s.skills, "skill")} across ${plural(s.locations, "location")}, ` +
    `${plural(s.duplicated, "duplicated skill")}, ${plural(s.broken, "broken symlink")}.`
  );
}

// A skill's tier badge: External when skills.sh owns any occurrence (lockfile
// attribution, ADR-0007), else Personal when any occurrence matches the
// ADR-0004 heuristic. Unattributed occurrences show no badge — their
// provenance line already reads "provenance unknown".
// (groupTier lives in cat.js — the catalog and the page share one rule.)

function renderSkill(group, store) {
  const tier = groupTier(group.occurrences, store);
  const tierBadge = tier ? ` <span class="tier tier-${tier.toLowerCase()}">${tier}</span>` : "";
  // Tag order mirrors renderStatus: linked spread else duplicate, then the
  // content-hash duplicate — the literal bracket texts, so the page reads like
  // the CLI report.
  const tags = [];
  if (group.linkedSpread) tags.push(`<span class="tag tag-spread">[linked spread]</span>`);
  else if (group.duplicate) tags.push(`<span class="tag tag-duplicate">[duplicate]</span>`);
  if (group.hashDuplicate) {
    tags.push(`<span class="tag tag-duplicate">[duplicate — same content, other name]</span>`);
  }

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
      `        <li class="location">` +
      `<div class="loc-line"><span class="root">${escapeHtml(scanRootLabel(occ.scanRoot))}</span>` +
      ` — <code class="path">${escapeHtml(occ.dir)}</code>${link}</div>` +
      `<div class="loc-meta">${escapeHtml(versionLine(occ))} | provenance: ${escapeHtml(provenanceSummary(occ))}</div>` +
      `</li>\n`
    );
  });

  return (
    `      <article class="skill">\n` +
    `        <h3>${escapeHtml(group.name)}${tierBadge}${tags.length ? " " + tags.join(" ") : ""}</h3>\n` +
    descriptionHtml +
    `        <ul class="locations">\n${locations.join("")}        </ul>\n` +
    `      </article>\n`
  );
}

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
  const vocabulary = config?.categories?.length ? config.categories : DEFAULT_CATEGORIES;
  const sections = groupByCategory(groups, vocabulary);
  const skillsHtml = sections.length
    ? sections
        .map(
          (section) =>
            `      <h2>${escapeHtml(section.category)} (${section.skills.length})</h2>\n` +
            section.skills.map((g) => renderSkill(g, store)).join(""),
        )
        .join("")
    : `      <p class="empty">(none)</p>\n`;

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
  h2 { font-size: 19px; margin: 34px 0 12px; }
  .meta { margin: 2px 0; color: #5b6572; font-size: 13.5px; }
  .summary { margin: 14px 0 0; padding: 12px 16px; background: #eef2f6; border-radius: 10px; font-size: 15px; }
  .skill { background: #fff; border: 1px solid #e3e8ee; border-radius: 12px; padding: 14px 18px; margin: 12px 0; }
  .skill h3 { margin: 0; font-size: 16.5px; }
  .desc { margin: 6px 0 0; color: #3d4754; font-size: 14px; }
  .tag { font-size: 12.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .tag-spread { color: #10603e; background: #e2f5ea; }
  .tag-duplicate { color: #8a4b08; background: #fdf0dd; }
  .tag-broken { color: #a11c1c; background: #fbe4e4; }
  .tier { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
          color: #47525f; background: #e8ecf1; padding: 2px 8px; border-radius: 999px; }
  ul.locations { list-style: none; margin: 10px 0 0; padding: 0; }
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
    <p>Generated by Skill Ninja from the cached inventory — regenerate with <code>ninja page</code> after <code>ninja init</code>. Self-contained static file; no server, no external assets, no network.</p>
  </footer>
</div>
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
      "Self-contained static HTML — open it in a browser; re-run `ninja page` to refresh.\n",
  );
  return 0;
}
