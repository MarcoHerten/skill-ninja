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
    const { stdout, exitCode } = await runCli(sb.home, ["cat"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

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

    const { stdout, exitCode } = await runCli(sb.home, ["cat", "assign", "aphrodite", "Marketing & Social"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

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
    });
    await plantSkill(sb.home, ".claude/skills/mcp-builder", {
      frontmatter: { name: "mcp-builder", category: "Meta & Agent Tooling" },
    });
    await plantSkill(sb.home, ".claude/skills/bare");
    const init = await runCli(sb.home, ["init"]);
    assert.equal(init.exitCode, 0, init.stderr);

    const { stdout, exitCode } = await runCli(sb.home, ["page"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    const html = await readPage(sb.home);

    // Category sections as h2, vocabulary order, Uncategorized last.
    const order = ["<h2>Marketing &amp; Social", "<h2>Meta &amp; Agent Tooling", "<h2>Uncategorized"].map((h) =>
      html.indexOf(h),
    );
    assert.ok(order.every((i) => i !== -1), `missing a category heading, got:\n${html}`);
    assert.ok(order[0] < order[1] && order[1] < order[2], `wrong section order`);

    // The description renders under the skill; missing descriptions stay absent.
    assert.ok(html.includes("Writes LinkedIn posts."), `expected the description`);

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
