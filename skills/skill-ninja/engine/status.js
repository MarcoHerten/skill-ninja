// The `status` view: render the cached inventory (written by `init`) as one
// unified, non-expert-readable report. `status` does NOT re-scan the filesystem
// — it reads ~/.skill-ninja/inventory.json (SPEC.md, "No anti-patterns"; status
// is computed on demand from the cache).
//
// The inventory is one entry per physical occurrence; `status` groups occurrences
// by name to present each logical Skill once, with all its location(s). A Skill
// with more than one location is a duplicate (CONTEXT.md: "the same skill in
// multiple places" — the visible symptom of tool asymmetry). Broken symlinks are
// listed distinctly. Version / provenance are shown where known.
//
// Filters narrow the view. (Issue #4; CONTEXT.md: Skill, Provenance, Agent root,
// Tool asymmetry; the tiers.)

// Human-friendly scan-root labels. Configured agent keys map to product names;
// a vault or project scan root shows its kind + absolute path. Labels mirror the
// agent families in engine/agents.js (skills.sh's conventions, ADR-0007/0008).
const AGENT_LABELS = {
  claude: "Claude root",
  codex: "Codex root",
  cursor: "Cursor root",
  gemini: "Gemini root",
  copilot: "Copilot root",
  windsurf: "Windsurf root",
  roo: "Roo root",
  trae: "Trae root",
  zcode: "ZCode root",
  agents: "agents root",
  opencode: "Opencode root",
  goose: "Goose root",
};

/**
 * A readable label for a scan root from the inventory.
 * @param {{kind:string, ref:string}} scanRoot
 * @returns {string}
 */
export function scanRootLabel(scanRoot) {
  if (!scanRoot) return "(unknown scan root)";
  if (scanRoot.kind === "agent") return AGENT_LABELS[scanRoot.ref] ?? `${scanRoot.ref} root`;
  if (scanRoot.kind === "vault") return `vault ${scanRoot.ref}`;
  if (scanRoot.kind === "project") return `project ${scanRoot.ref}`;
  return `${scanRoot.kind} ${scanRoot.ref}`;
}

/**
 * Compact provenance/tier summary. An External skill (attributed to skills.sh via
 * its lockfile, ADR-0007/0008) is reported as external + its skills.sh source;
 * otherwise the frontmatter provenance is summarized, with "provenance unknown"
 * when absent or empty.
 * @param {object} occ A skill occurrence (uses tier / external / provenance).
 * @returns {string}
 */
export function provenanceSummary(occ) {
  if (occ?.tier === "external" && occ.external) {
    const bits = ["external"];
    if (occ.external.source) bits.push(`from ${occ.external.source}`);
    return bits.join(", ");
  }
  const provenance = occ?.provenance;
  if (!provenance) return "provenance unknown";
  const bits = [];
  if (provenance.source) bits.push(provenance.source);
  if (provenance.from) bits.push(`from ${provenance.from}`);
  if (provenance.imported) bits.push(`imported ${provenance.imported}`);
  return bits.length ? bits.join(", ") : "provenance unknown";
}

// Personal-tier heuristic (ADR-0004): a skill occurrence is Personal if it lives
// under the configured canonical store path, or its provenance.source is
// "authored". External skills (owned by skills.sh) are never Personal.
function isPersonal(occ, store) {
  if (occ.tier === "external") return false;
  if (store) {
    const prefix = store.endsWith("/") ? store : store + "/";
    if (occ.dir === store || occ.dir.startsWith(prefix)) return true;
  }
  return occ.provenance?.source === "authored";
}

// `version: <v>` plus an `(updated <u>)` suffix when the updated date is known.
function versionLine(occ) {
  const v = occ.version ?? "unknown";
  let line = `version: ${v}`;
  if (occ.updated) line += ` (updated ${occ.updated})`;
  return line;
}

// Group per-occurrence entries by name -> { name, occurrences, duplicate }.
function groupSkills(skills) {
  const map = new Map();
  for (const occ of skills) {
    if (!map.has(occ.name)) map.set(occ.name, []);
    map.get(occ.name).push(occ);
  }
  const groups = [];
  for (const [name, occurrences] of map) {
    groups.push({ name, occurrences, duplicate: occurrences.length > 1 });
  }
  return groups;
}

function plural(n, word) {
  return `${n} ${n === 1 ? word : word + "s"}`;
}

/**
 * Render the cached inventory as a unified, readable status report.
 *
 * Filter semantics (they may compose):
 * - `--broken`        -> show only broken symlinks (skills hidden).
 * - `--duplicates`    -> show only skills with >1 location (broken hidden).
 * - `--personal`      -> show only Personal skills (broken hidden).
 * - skill filters AND together; `--broken` adds the broken section back.
 *
 * @param {object} inventory The cached inventory (ADR-0003 schema).
 * @param {{store?:string|null}} config Resolved config (only `store` is used).
 * @param {{broken:boolean, duplicates:boolean, personal:boolean}} flags
 * @returns {string} The report, with a trailing newline.
 */
export function renderStatus(inventory, config, flags) {
  const store = config?.store ?? null;
  const allGroups = groupSkills(inventory.skills ?? []);
  const allBroken = inventory.broken ?? [];

  const skillFilterActive = flags.duplicates || flags.personal;
  const brokenOnly = flags.broken && !skillFilterActive;
  const showSkills = !brokenOnly;
  const showBroken = !skillFilterActive || flags.broken;

  let groups = allGroups;
  if (skillFilterActive) {
    groups = allGroups.filter((g) => {
      if (flags.duplicates && !g.duplicate) return false;
      if (flags.personal && !g.occurrences.some((o) => isPersonal(o, store))) return false;
      return true;
    });
  }
  const broken = showBroken ? allBroken : [];
  // The summary describes what this report shows: when skills are hidden
  // (--broken alone), they contribute zero to the counts.
  const shownGroups = showSkills ? groups : [];

  const dupCount = shownGroups.filter((g) => g.duplicate).length;
  const locCount = shownGroups.reduce((n, g) => n + g.occurrences.length, 0);

  const lines = ["Skill Ninja status"];
  if (inventory.generatedAt) lines.push(`(inventory from ${inventory.generatedAt})`);

  const active = [];
  if (flags.broken) active.push("--broken");
  if (flags.duplicates) active.push("--duplicates");
  if (flags.personal) active.push("--personal");
  if (active.length) lines.push(`(filtering: ${active.join(" ")})`);

  lines.push(
    "",
    `${plural(shownGroups.length, "skill")} across ${plural(locCount, "location")}, ` +
      `${plural(dupCount, "duplicated skill")}, ${plural(broken.length, "broken symlink")}.`,
  );

  if (showSkills) {
    lines.push("", "Skills:");
    if (groups.length === 0) {
      lines.push("  (none)");
    } else {
      for (const g of groups) {
        lines.push(`  ${g.name}${g.duplicate ? " [duplicate]" : ""}`);
        for (const occ of g.occurrences) {
          lines.push(`    ${scanRootLabel(occ.scanRoot)} - ${occ.dir}`);
          lines.push(`      ${versionLine(occ)}  |  provenance: ${provenanceSummary(occ)}`);
        }
      }
    }
  }

  if (showBroken) {
    lines.push("", "Broken symlinks:");
    if (broken.length === 0) {
      lines.push("  (none)");
    } else {
      for (const b of broken) {
        lines.push(`  [broken symlink] ${b.path} - ${scanRootLabel(b.scanRoot)}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
