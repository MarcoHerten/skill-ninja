// Black-box tests for `ninja cat` — the category catalog (Issue #10) and the
// category machinery behind it: `init` capturing `category` / `description`
// into the cached inventory (schema v3), the `cat` catalog view, `cat assign`
// (the frontmatter stamp write), the page's category regrouping, and the
// stamp's carry-forward through `add`. Tests seed the cache the realistic way
// (plant a landscape, run `init`), run the CLI, and assert on stdout, the
// written files, and git state. They never import engine code (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  parseStamps,
  makeStoreGitRepo,
  storePath,
} from "./helpers/harness.js";

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

// Everything after the closing `---` fence, byte for byte — proves a stamp
// write never touches the body. Local helper so tests stay black-box.
function splitBody(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "---", `expected frontmatter, got:\n${text.slice(0, 80)}`);
  const close = lines.indexOf("---", 1);
  assert.ok(close !== -1, `expected a closing fence`);
  return lines.slice(close + 1).join("\n");
}

function commitSubjects(store, pattern) {
  const out = execFileSync("git", ["-C", store, "log", "--pretty=%s"], { encoding: "utf8" });
  return out.split("\n").filter((s) => pattern.test(s));
}

// --- Slice A: init captures category + description (inventory schema v3) ----

test("init captures category and description from frontmatter, null when absent", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/categorized", {
      frontmatter: {
        name: "categorized",
        category: "Marketing & Social",
        description: "Writes LinkedIn posts from a topic.",
        version: "1.0.0",
      },
    });
    await plantSkill(sb.home, ".claude/skills/bare");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    assert.equal(cache.version, 3, `expected inventory schema v3, got: ${cache.version}`);
    const byName = Object.fromEntries(cache.skills.map((s) => [s.name, s]));
    assert.equal(byName.categorized.category, "Marketing & Social");
    assert.equal(byName.categorized.description, "Writes LinkedIn posts from a topic.");
    assert.equal(byName.bare.category, null);
    assert.equal(byName.bare.description, null);
  } finally {
    await sb.cleanup();
  }
});

// Block-scalar descriptions (`description: >-` …) are the style longer
// agent-activation texts are written in — init must unfold them into the
// one-line value the catalog shows, never store the `>-` literal.
test("init unfolds YAML block-scalar descriptions (>- / > / |) into one-line values", async () => {
  const sb = await createSandbox();
  try {
    const dir = join(sb.home, ".claude/skills");
    const plantRaw = async (name, frontmatter) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(
        join(dir, name, "SKILL.md"),
        `---\n${frontmatter}\n---\n\n# ${name}\n`,
        "utf8",
      );
    };
    await plantRaw(
      "folded",
      "name: folded\ndescription: >-\n  Writes posts from a topic\n  across several lines.\ncategory: Content & Writing\nversion: 1.4.0",
    );
    await plantRaw(
      "literal",
      "name: literal\ncategory: Content & Writing\ndescription: |-\n  Edits documents\n  carefully.",
    );
    await plantRaw("clip", "name: clip\ndescription: >\n  Folds to one line.");
    await plantRaw("empty-block", "name: empty-block\ndescription: >-");

    await runCli(sb.home, ["init"]);
    const cache = await readInventory(sb.home);
    const byName = Object.fromEntries(cache.skills.map((s) => [s.name, s]));
    assert.equal(byName.folded.description, "Writes posts from a topic across several lines.");
    assert.equal(byName.folded.category, "Content & Writing", "the key after the block must still parse");
    assert.equal(byName.folded.version, "1.4.0");
    assert.equal(byName.literal.description, "Edits documents carefully.");
    assert.equal(byName.clip.description, "Folds to one line.");
    assert.equal(byName["empty-block"].description, null);

    const { stdout, exitCode } = await runCli(sb.home, ["cat", "content"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /folded — Writes posts from a topic across several lines\./);
    assert.match(stdout, /literal — Edits documents carefully\./);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice B: the catalog view ------------------------------------------------

test("cat prints the landscape grouped by category with descriptions, tier badges, and counts", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite-linkedin-post", {
      frontmatter: { name: "aphrodite", category: "Marketing & Social", description: "Writes LinkedIn posts." },
    });
    await plantSkill(sb.home, ".claude/skills/mcp-builder", {
      frontmatter: { name: "mcp-builder", category: "Meta & Agent Tooling", description: "Builds MCP servers." },
    });
    await plantSkill(sb.home, ".claude/skills/athena", {
      frontmatter: { name: "athena", category: "Strategy & Management" },
    });
    await plantSkill(sb.home, ".claude/skills/bare-one");
    await plantSkill(sb.home, ".claude/skills/bare-two");

    const init = await runCli(sb.home, ["init"]);
    assert.equal(init.exitCode, 0, init.stderr);
    const { stdout, stderr, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stderr}`);

    // Header + counts: 5 skills, 3 categorized (2 uncategorized).
    assert.match(stdout, /Skill Ninja catalog/);
    assert.match(stdout, /5 skills across 3 categories, 2 uncategorized/);

    // Vocabulary order first (Strategy before Marketing before Meta), then any
    // custom categories, Uncategorized always last.
    const iStrategy = stdout.indexOf("Strategy & Management (1):");
    const iMarketing = stdout.indexOf("Marketing & Social (1):");
    const iMeta = stdout.indexOf("Meta & Agent Tooling (1):");
    const iUncat = stdout.indexOf("Uncategorized (2):");
    assert.ok(iStrategy !== -1 && iMarketing !== -1 && iMeta !== -1 && iUncat !== -1, `got:\n${stdout}`);
    assert.ok(iStrategy < iMarketing && iMarketing < iMeta && iMeta < iUncat, `got:\n${stdout}`);

    // Entries: name — description; missing description is explicit, never blank.
    assert.match(stdout, /aphrodite — Writes LinkedIn posts\./);
    assert.match(stdout, /athena — \(no description\)/);
    assert.match(stdout, /bare-one — \(no description\)/);
    assert.match(stdout, /bare-two — \(no description\)/);
  } finally {
    await sb.cleanup();
  }
});

test("cat shows tier badges with the same rule as status (External via lockfile, Personal via authored)", async () => {
  const sb = await createSandbox();
  try {
    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { "ext-skill": { source: "some/repo", sourceType: "github", computedHash: "deadbeef" } },
      }),
      "utf8",
    );
    await plantSkill(sb.home, ".claude/skills/ext-skill", {
      frontmatter: { name: "ext-skill", category: "Design & Documents", description: "External." },
    });
    await plantSkill(sb.home, ".claude/skills/own-skill", {
      frontmatter: {
        name: "own-skill",
        category: "Design & Documents",
        provenance: { source: "authored", from: "Marco", imported: "2026-06-01", derived_from: null },
      },
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /ext-skill \[External\] — External\./);
    assert.match(stdout, /own-skill \[Personal\] — \(no description\)/);
  } finally {
    await sb.cleanup();
  }
});

test("cat orders custom categories after the vocabulary and follows a configured vocabulary", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude"],
      vaults: [],
      projects: [],
      categories: ["Zed Custom", "Alpha Custom"],
    },
  });
  try {
    await plantSkill(sb.home, ".claude/skills/a", { frontmatter: { name: "a", category: "Alpha Custom" } });
    await plantSkill(sb.home, ".claude/skills/z", { frontmatter: { name: "z", category: "Zed Custom" } });
    await plantSkill(sb.home, ".claude/skills/v", { frontmatter: { name: "v", category: "Marketing & Social" } });
    await plantSkill(sb.home, ".claude/skills/u");
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0);
    // Configured vocabulary first (its order), then remaining known/custom
    // categories, Uncategorized last.
    const order = ["Zed Custom (1):", "Alpha Custom (1):", "Marketing & Social (1):", "Uncategorized (1):"].map(
      (h) => stdout.indexOf(h),
    );
    assert.ok(order.every((i) => i !== -1), `missing a heading, got:\n${stdout}`);
    assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

test("cat <term> filters to matching categories (case-insensitive substring) and helps on no match", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite", {
      frontmatter: { name: "aphrodite", category: "Marketing & Social", description: "Posts." },
    });
    await plantSkill(sb.home, ".claude/skills/bare");
    await runCli(sb.home, ["init"]);

    const filtered = await runCli(sb.home, ["cat", "marketing"]);
    assert.equal(filtered.exitCode, 0);
    assert.match(filtered.stdout, /filtering: marketing/);
    assert.match(filtered.stdout, /1 skill across 1 category, 0 uncategorized/);
    assert.match(filtered.stdout, /Marketing & Social \(1\):/);
    assert.match(filtered.stdout, /aphrodite — Posts\./);
    assert.doesNotMatch(filtered.stdout, /Uncategorized/);
    assert.doesNotMatch(filtered.stdout, /bare/);

    const none = await runCli(sb.home, ["cat", "nonexistent"]);
    assert.equal(none.exitCode, 0);
    assert.match(none.stdout, /No category matching 'nonexistent'/);
    assert.match(none.stdout, /Marketing & Social/); // the available categories are listed
  } finally {
    await sb.cleanup();
  }
});

// Agent-activation descriptions run to hundreds of characters — the catalog
// shows a one-liner: cut at a sentence boundary when one fits, else at a word
// with an ellipsis. The full text stays in the SKILL.md and on the page.
test("cat truncates long descriptions at a sentence boundary, or at a word with an ellipsis", async () => {
  const sb = await createSandbox();
  try {
    const withSentence = "Writes LinkedIn posts. " + "Trigger words repeat and repeat ".repeat(8);
    const noSentence = "word ".repeat(60); // no sentence boundary within the limit
    await plantSkill(sb.home, ".claude/skills/two-sentences", {
      frontmatter: { name: "two-sentences", category: "Marketing & Social", description: withSentence },
    });
    await plantSkill(sb.home, ".claude/skills/no-sentence", {
      frontmatter: { name: "no-sentence", category: "Marketing & Social", description: noSentence },
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["cat", "marketing"]);
    assert.equal(exitCode, 0);
    // First sentence fits -> shown whole with no ellipsis; the rest is cut.
    assert.match(stdout, /two-sentences — Writes LinkedIn posts\.$/m);
    assert.ok(!stdout.includes("Trigger words repeat"));
    // No sentence boundary -> word cut plus ellipsis, still one line per entry.
    const line = stdout.split("\n").find((l) => l.includes("no-sentence"));
    assert.ok(line, `expected a no-sentence entry`);
    assert.match(line, /no-sentence — \S.*\S …$/);
    assert.ok(line.length <= "  no-sentence — ".length + 102, `line stays one-liner length: ${line}`);
  } finally {
    await sb.cleanup();
  }
});

test("cat lists skills alphabetically within a category section", async () => {
  const sb = await createSandbox();
  try {
    // Planted out of order on purpose — scan order must not leak into the view.
    for (const n of ["zeta", "alpha", "mid"]) {
      await plantSkill(sb.home, `.claude/skills/${n}`, {
        frontmatter: { name: n, category: "Meta & Agent Tooling", description: `${n} does things.` },
      });
    }
    await runCli(sb.home, ["init"]);
    const { stdout, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0);
    const order = ["alpha —", "mid —", "zeta —"].map((s) => stdout.indexOf(s));
    assert.ok(order.every((i) => i !== -1), `missing an entry, got:\n${stdout}`);
    assert.ok(order[0] < order[1] && order[1] < order[2], `entries must be alphabetical, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

test("cat with no inventory points to init; unknown flags are rejected", async () => {
  const sb = await createSandbox();
  try {
    const noCache = await runCli(sb.home, ["cat"]);
    assert.equal(noCache.exitCode, 0);
    assert.match(noCache.stdout, /No Skill Ninja inventory found/);
    assert.match(noCache.stdout, /init/i);

    await plantSkill(sb.home, ".claude/skills/a");
    await runCli(sb.home, ["init"]);
    const bad = await runCli(sb.home, ["cat", "--all"]);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /Unknown cat argument: --all/);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice C: cat assign — the stamp write ------------------------------------

// A stored skill fixture: stamped frontmatter resembling `add`'s output.
async function plantStoredSkill(home, name, { category = null } = {}) {
  const dir = join(storePath(home), name);
  await mkdir(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${name}`,
    ...(category ? [`category: "${category}"`] : []),
    "version: 1.2.0",
    "updated: 2026-07-01",
    "hash: abc123def456",
    "provenance:",
    "  source: received",
    '  from: "a friend"',
    "  imported: 2026-06-01",
    "  derived_from: null",
    "  relation: null",
    "---",
    "",
  ].join("\n");
  const body = `# ${name}\n\nThe instructions.\n`;
  await writeFile(join(dir, "SKILL.md"), fm + "\n" + body, "utf8");
  return { dir, file: join(dir, "SKILL.md"), body: "\n" + body };
}

test("cat assign stamps the category on the stored copy, leaves body/version/hash untouched, and commits", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantStoredSkill(sb.home, "aphrodite");
    const store = makeStoreGitRepo(sb.home);
    const before = await readFile(planted.file, "utf8");

    const { stdout, stderr, exitCode } = await runCli(sb.home, ["cat", "assign", "aphrodite", "Marketing & Social"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stderr}`);

    const after = await readFile(planted.file, "utf8");
    const stamps = parseStamps(after);
    assert.equal(stamps.category, "Marketing & Social");
    assert.equal(stamps.version, "1.2.0", "version must not change");
    assert.equal(stamps.hash, "abc123def456", "content hash must not change");
    assert.equal(splitBody(after), splitBody(before), "the body must be byte-identical");
    // Exactly one category line — no duplicates from a second stamp.
    assert.equal((after.match(/^category:/m) ?? []).length, 1);

    assert.match(stdout, /Categorized 'aphrodite' as 'Marketing & Social'/);
    assert.ok(stdout.includes(planted.file), `expected the stamped file path`);
    assert.deepEqual(commitSubjects(store, /^categorize aphrodite$/), ["categorize aphrodite"]);
  } finally {
    await sb.cleanup();
  }
});

test("cat assign warns on a category outside the vocabulary but still stamps it", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantStoredSkill(sb.home, "oddball");
    makeStoreGitRepo(sb.home);

    const { stdout, exitCode } = await runCli(sb.home, ["cat", "assign", "oddball", "Weird Stuff"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Warning: 'Weird Stuff' is not in the configured category vocabulary/);
    assert.equal(parseStamps(await readFile(planted.file, "utf8")).category, "Weird Stuff");
  } finally {
    await sb.cleanup();
  }
});

test("cat assign is idempotent (same category: no rewrite, no commit) and re-assign replaces the line", async () => {
  const sb = await createSandbox();
  try {
    await plantStoredSkill(sb.home, "shape", { category: "Marketing & Social" });
    const store = makeStoreGitRepo(sb.home);
    // Baseline commit so "no new commit" assertions count only assign commits.
    execFileSync("git", ["-C", store, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", store, "commit", "-q", "-m", "baseline"], { stdio: "ignore" });

    const again = await runCli(sb.home, ["cat", "assign", "shape", "Marketing & Social"]);
    assert.equal(again.exitCode, 0);
    assert.match(again.stdout, /Already categorized 'shape' as 'Marketing & Social'/);
    assert.equal(commitSubjects(store, /categorize/).length, 0);

    const moved = await runCli(sb.home, ["cat", "assign", "shape", "Content & Writing"]);
    assert.equal(moved.exitCode, 0);
    const after = await readFile(join(store, "shape", "SKILL.md"), "utf8");
    assert.equal(parseStamps(after).category, "Content & Writing");
    assert.equal((after.match(/^category:/m) ?? []).length, 1, "the old line must be replaced, not duplicated");
    assert.equal(commitSubjects(store, /categorize/).length, 1);
  } finally {
    await sb.cleanup();
  }
});

test("cat assign refuses skills outside the store and rejects bad usage", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    // A loose copy in an agent root — never the write target (ADR-0007: only
    // stored Personal skills are stamped).
    await plantSkill(sb.home, ".claude/skills/loose-skill");

    const loose = await runCli(sb.home, ["cat", "assign", "loose-skill", "Marketing & Social"]);
    assert.equal(loose.exitCode, 2);
    assert.match(loose.stderr, /No skill 'loose-skill' found in the canonical store/);
    assert.match(loose.stderr, /add/i);

    const missing = await runCli(sb.home, ["cat", "assign", "ghost", "Marketing & Social"]);
    assert.equal(missing.exitCode, 2);

    const usage = await runCli(sb.home, ["cat", "assign", "only-a-name"]);
    assert.equal(usage.exitCode, 2);
    assert.match(usage.stderr, /Try: ninja cat assign <name> <category>/);

    const empty = await runCli(sb.home, ["cat", "assign", "x", ""]);
    assert.equal(empty.exitCode, 2);
    assert.match(empty.stderr, /empty/);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice D: the page regroups by category -----------------------------------

async function readPage(home) {
  return readFile(join(home, ".skill-ninja", "status.html"), "utf8");
}

test("page groups skills under category headings in the same order as cat, with descriptions", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite", {
      frontmatter: { name: "aphrodite", category: "Marketing & Social", description: "Writes LinkedIn posts." },
      body: "# Aphrodite body\n",
    });
    await plantSkill(sb.home, ".claude/skills/mcp-builder", {
      frontmatter: { name: "mcp-builder", category: "Meta & Agent Tooling" },
      body: "# MCP body\n",
    });
    await plantSkill(sb.home, ".claude/skills/bare");
    const init = await runCli(sb.home, ["init"]);
    assert.equal(init.exitCode, 0, init.stderr);

    const { stdout, stderr, exitCode } = await runCli(sb.home, ["page"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stderr}`);
    const html = await readPage(sb.home);

    // Category sections as h2, vocabulary order, Uncategorized last.
    const order = ["<h2>Marketing &amp; Social", "<h2>Meta &amp; Agent Tooling", "<h2>Uncategorized"].map((h) =>
      html.indexOf(h),
    );
    assert.ok(order.every((i) => i !== -1), `missing a category heading, got:\n${html}`);
    assert.ok(order[0] < order[1] && order[1] < order[2], `wrong section order`);

    // The description renders under the skill; missing descriptions stay absent.
    assert.ok(html.includes("Writes LinkedIn posts."), `expected the description`);

    // Membership cross-check: the page's category sections contain exactly the
    // skills the CLI catalog reports per category (same grouping code — proven,
    // not assumed).
    const cat = await runCli(sb.home, ["cat"]);
    assert.equal(cat.exitCode, 0);
    const expected = {};
    let heading = null;
    for (const line of cat.stdout.split("\n")) {
      const m = line.match(/^(.+) \(\d+\):$/);
      if (m) {
        heading = m[1];
        expected[heading] = [];
      } else if (heading && line.startsWith("  ")) {
        // Strip tier badge and any spread/duplicate tags from the entry name.
        expected[heading].push(line.trim().split(" — ")[0].replace(/ \[[^\]]*\]/g, ""));
      }
    }
    const pageSections = html
      .split("<h2>")
      .slice(1)
      .map((chunk) => ({
        category: chunk
          .slice(0, chunk.indexOf("</h2>"))
          .replace(/\s*\(\d+\)$/, "")
          .replace(/&amp;/g, "&"),
        names: [...chunk.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) =>
          m[1].replace(/<[^>]+>/g, "").trim().replace(/ \[[^\]]*\]/g, ""),
        ),
      }))
      // The page has one more h2 section (Broken symlinks) with no skills.
      .filter((s) => expected[s.category] !== undefined);
    assert.deepEqual(
      Object.fromEntries(pageSections.map((s) => [s.category, s.names])),
      expected,
      `page sections must match the catalog membership`,
    );

    // A category value is data: escaped, never markup.
    await plantSkill(sb.home, ".claude/skills/angry", {
      frontmatter: { name: "angry", category: "A<b>&c" },
    });
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["page"]);
    const html2 = await readPage(sb.home);
    assert.ok(html2.includes("A&lt;b&gt;&amp;c"), `expected the escaped category`);
    assert.ok(!html2.includes("A<b>&c"), `the raw category must never appear as markup`);
  } finally {
    await sb.cleanup();
  }
});

// --- More init / vocabulary edges ----------------------------------------------

test("init records null category/description on malformed frontmatter and never throws", async () => {
  const sb = await createSandbox();
  try {
    // A SKILL.md whose frontmatter never closes — unparseable, must not crash
    // the scan (ADR-0003: `init` never throws on a malformed SKILL.md).
    const dir = join(sb.home, ".claude/skills/malformed");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: malformed\ncategory: Marketing & Social\n# the fence never closes\n",
      "utf8",
    );

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "malformed");
    assert.ok(found, `expected the malformed skill in the inventory`);
    assert.equal(found.category, null);
    assert.equal(found.description, null);
  } finally {
    await sb.cleanup();
  }
});

test("cat treats an explicitly empty configured vocabulary as custom-everything", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude"],
      vaults: [],
      projects: [],
      categories: [],
    },
  });
  try {
    await plantSkill(sb.home, ".claude/skills/b", { frontmatter: { name: "b", category: "Beta Group" } });
    await plantSkill(sb.home, ".claude/skills/a", { frontmatter: { name: "a", category: "Alpha Group" } });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0);
    // No vocabulary ranks apply: categories fall back to alphabetical order.
    const iAlpha = stdout.indexOf("Alpha Group (1):");
    const iBeta = stdout.indexOf("Beta Group (1):");
    assert.ok(iAlpha !== -1 && iBeta !== -1 && iAlpha < iBeta, `got:\n${stdout}`);

    const cfg = await runCli(sb.home, ["config", "show"]);
    assert.match(cfg.stdout, /configured empty — every category is custom/);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice E: the stamp travels through `add` ---------------------------------

test("add keeps the skill's own category stamp and carries a prior category forward on re-add", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    const src = join(sb.home, "Downloads", "aphrodite");
    await mkdir(src, { recursive: true });
    const skillMd = (category) =>
      `---\nname: aphrodite\n${category ? `category: "${category}"\n` : ""}description: "Writes posts."\n---\n\n# Aphrodite\n\nBody.\n`;
    await writeFile(join(src, "SKILL.md"), skillMd("Marketing & Social"), "utf8");

    // New add: the incoming category survives stamping.
    const first = await runCli(sb.home, ["add", src, "--to", "claude"]);
    assert.equal(first.exitCode, 0, `stderr:\n${first.stderr}`);
    let stored = await readFile(join(storePath(sb.home), "aphrodite", "SKILL.md"), "utf8");
    assert.equal(parseStamps(stored).category, "Marketing & Social");

    // Identical re-add without a category in the source: the prior category
    // carries forward (like description), instead of being dropped.
    await writeFile(join(src, "SKILL.md"), skillMd(null), "utf8");
    const second = await runCli(sb.home, ["add", src, "--to", "claude"]);
    assert.equal(second.exitCode, 0, `stderr:\n${second.stderr}`);
    stored = await readFile(join(storePath(sb.home), "aphrodite", "SKILL.md"), "utf8");
    assert.equal(parseStamps(stored).category, "Marketing & Social");
    assert.equal(parseStamps(stored).version, "1.0.0", "identical re-add must not bump the version");
  } finally {
    await sb.cleanup();
  }
});
