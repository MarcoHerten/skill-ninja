// The `status` view: render the cached inventory (written by `init`) as one
// unified, non-expert-readable report. `status` does NOT re-scan the filesystem
// — it reads ~/.skill-ninja/inventory.json (SPEC.md, "No anti-patterns"; status
// is computed on demand from the cache).
//
// The inventory is one entry per physical occurrence; `status` groups occurrences
// by name to present each logical Skill once, with all its location(s). A Skill
// with more than one location is flagged — `[duplicate]` when independent copies
// exist, `[linked spread]` when every location resolves to one canonical copy
// (symlink awareness, inventory schema v2: `add`'s store links and skills.sh's
// install pattern alike). Symlink locations show `→ <resolved target>`. Broken
// symlinks are listed distinctly. Version / provenance are shown where known.
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
  antigravity: "Antigravity root",
  "antigravity-cli": "Antigravity CLI root",
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
  // "Claude root" -> "Claude plugins": the plugin cache of the same agent.
  if (scanRoot.kind === "plugin") {
    const label = AGENT_LABELS[scanRoot.ref] ?? `${scanRoot.ref} root`;
    return `${label.replace(/ root$/, "")} plugins`;
  }
  if (scanRoot.kind === "vault") return `vault ${scanRoot.ref}`;
  if (scanRoot.kind === "project") return `project ${scanRoot.ref}`;
  if (scanRoot.kind === "store") return "canonical store";
  return `${scanRoot.kind} ${scanRoot.ref}`;
}

/**
 * Compact provenance/tier summary. An External skill (attributed to skills.sh via
 * its lockfile, ADR-0007/0008) is reported as external + its skills.sh source;
 * a Plugin skill (bundled in an agent plugin, ADR-0018) as plugin-bundled + the
 * plugin's name; otherwise the frontmatter provenance is summarized, with
 * "provenance unknown" when absent or empty.
 * @param {object} occ A skill occurrence (uses tier / external / plugin / provenance).
 * @returns {string}
 */
export function provenanceSummary(occ) {
  if (occ?.tier === "external" && occ.external) {
    const bits = ["external"];
    if (occ.external.source) bits.push(`from ${occ.external.source}`);
    return bits.join(", ");
  }
  if (occ?.tier === "plugin") {
    return occ.plugin ? `plugin-bundled in '${occ.plugin}'` : "plugin-bundled";
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
// "authored". External skills (owned by skills.sh) and Plugin skills (owned by
// the agent's plugin system) are never Personal. Exported for `page`, which
// badges each skill's tier with the same rule.
export function isPersonal(occ, store) {
  if (occ.tier === "external" || occ.tier === "plugin") return false;
  if (store) {
    const prefix = store.endsWith("/") ? store : store + "/";
    if (occ.dir === store || occ.dir.startsWith(prefix)) return true;
  }
  return occ.provenance?.source === "authored";
}

// `version: <v>` plus an `(updated <u>)` suffix when the updated date is known.
// Exported for `page`, which renders the same line per location.
export function versionLine(occ) {
  const v = occ.version ?? "unknown";
  let line = `version: ${v}`;
  if (occ.updated) line += ` (updated ${occ.updated})`;
  return line;
}

// A linked spread (inventory schema v2): a multi-location group that resolves
// to ONE canonical copy — at most one real (non-symlink) occurrence, and every
// symlink occurrence resolves to that same directory. This covers both healthy
// shapes: `add`'s links into the canonical store and skills.sh's install
// pattern (one real dir in an agent root, the other roots symlinked into it).
// A linked spread is tool asymmetry correctly handled, NOT a duplicate; only a
// spread with more than one independent copy is a duplicate. (CONTEXT.md
// "Duplicate"; the same rule drives `doctor`'s duplicate detection.)
function isLinkedSpread(occurrences) {
  if (occurrences.length < 2) return false;
  const real = occurrences.filter((o) => !o.symlink);
  const links = occurrences.filter((o) => o.symlink);
  if (real.length > 1 || links.length === 0) return false;
  const target = links[0].resolved;
  if (!links.every((o) => o.resolved === target)) return false;
  return real.length === 0 || real[0].resolved === target;
}

// Group per-occurrence entries by name -> { name, occurrences, duplicate,
// linkedSpread, hashDuplicate }. A group is a name-duplicate when the same name
// lives in more than one location (the primary identity signal) — unless the
// spread is linked (one canonical copy + links into it, the healthy state), or
// every occurrence is plugin-owned (ADR-0018: a plugin cache may legitimately
// hold several versions of the same bundled skill; that spread belongs to the
// agent's plugin manager, not to Skill Ninja's duplicate machinery). It
// is a content-duplicate (hashDuplicate) when any of its occurrences shares a
// content hash with an occurrence under a DIFFERENT name — the secondary signal
// that catches the same skill living under a different name (CONTEXT.md
// "Duplicate").
// Exported for `page`: the HTML status page is the browser counterpart of this
// report and MUST group/tag identically — one implementation, no divergent copy.
export function groupSkills(skills) {
  const map = new Map();
  for (const occ of skills) {
    if (!map.has(occ.name)) map.set(occ.name, []);
    map.get(occ.name).push(occ);
  }
  // hash -> set of distinct names sharing that content hash.
  const hashNames = new Map();
  for (const occ of skills) {
    if (!occ.hash) continue;
    if (!hashNames.has(occ.hash)) hashNames.set(occ.hash, new Set());
    hashNames.get(occ.hash).add(occ.name);
  }
  const groups = [];
  for (const [name, occurrences] of map) {
    const hashDuplicate = occurrences.some(
      (occ) => occ.hash && hashNames.get(occ.hash).size > 1,
    );
    groups.push({
      name,
      occurrences,
      duplicate: occurrences.length > 1 && !occurrences.every((o) => o.tier === "plugin"),
      linkedSpread: isLinkedSpread(occurrences),
      hashDuplicate,
    });
  }
  return groups;
}

export function plural(n, word) {
  return `${n} ${n === 1 ? word : word + "s"}`;
}

// A group's Availability (ADR-0014), computed from the same occurrence data
// every view shares. Off wins over Manual (an off skill is linked nowhere, so
// only its store occurrence — carrying the stamp — remains); a group with any
// occurrence outside the store is otherwise live somewhere ("active"); a group
// that exists ONLY in the store was stored but never linked (`ingest` output,
// or a stored skill whose links were removed without an off stamp) — "stored".
// External occurrences carry `availability: "off"` overlaid from the ZCode
// ledger at inventory-build time, so the rule reads one field uniformly.
// Exported for `page`, `find`, and the availability commands — one home.
export function groupAvailability(group) {
  const occs = group.occurrences ?? [];
  if (occs.some((o) => o.availability === "off")) return "off";
  if (occs.some((o) => o.availability === "manual")) return "manual";
  if (occs.some((o) => o.scanRoot?.kind !== "store")) return "active";
  return "stored";
}

// The status-line tag for a non-active Availability; active is the untagged
// default (the tag list must stay quiet for the common case).
export function availabilityTag(state) {
  if (state === "manual") return "[manual]";
  if (state === "off") return "[off]";
  if (state === "stored") return "[stored — not linked]";
  return "";
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
      // A problem duplicate: a multi-location spread that is NOT a healthy
      // linked spread, or the same content under another name.
      const problemDuplicate =
        (g.duplicate && !g.linkedSpread) || g.hashDuplicate;
      if (flags.duplicates && !problemDuplicate) return false;
      if (flags.personal && !g.occurrences.some((o) => isPersonal(o, store))) return false;
      return true;
    });
  }
  const broken = showBroken ? allBroken : [];
  // The summary describes what this report shows: when skills are hidden
  // (--broken alone), they contribute zero to the counts.
  const shownGroups = showSkills ? groups : [];

  const dupCount = shownGroups.filter(
    (g) => (g.duplicate && !g.linkedSpread) || g.hashDuplicate,
  ).length;
  const locCount = shownGroups.reduce((n, g) => n + g.occurrences.length, 0);
  // Availability totals (ADR-0014) — appended only when non-zero so the
  // classic summary line stays byte-identical on an all-active landscape.
  const manualCount = shownGroups.filter((g) => groupAvailability(g) === "manual").length;
  const offCount = shownGroups.filter((g) => groupAvailability(g) === "off").length;

  const lines = ["Skill Ninja status"];
  if (inventory.generatedAt) lines.push(`(inventory from ${inventory.generatedAt})`);

  const active = [];
  if (flags.broken) active.push("--broken");
  if (flags.duplicates) active.push("--duplicates");
  if (flags.personal) active.push("--personal");
  if (active.length) lines.push(`(filtering: ${active.join(" ")})`);

  let summary =
    `${plural(shownGroups.length, "skill")} across ${plural(locCount, "location")}, ` +
    `${plural(dupCount, "duplicated skill")}, ${plural(broken.length, "broken symlink")}.`;
  if (manualCount > 0 || offCount > 0) {
    summary += ` ${plural(manualCount, "manual skill")}, ${plural(offCount, "off skill")}.`;
  }
  lines.push("", summary);

  if (showSkills) {
    lines.push("", "Skills:");
    if (groups.length === 0) {
      lines.push("  (none)");
    } else {
      for (const g of groups) {
        const tags = [];
        const availTag = availabilityTag(groupAvailability(g));
        if (availTag) tags.push(availTag);
        if (g.linkedSpread) tags.push("[linked spread]");
        else if (g.duplicate) tags.push("[duplicate]");
        if (g.hashDuplicate) tags.push("[duplicate — same content, other name]");
        lines.push(`  ${g.name}${tags.length ? " " + tags.join(" ") : ""}`);
        for (const occ of g.occurrences) {
          const link = occ.symlink && occ.resolved ? ` → ${occ.resolved}` : "";
          lines.push(`    ${scanRootLabel(occ.scanRoot)} - ${occ.dir}${link}`);
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
