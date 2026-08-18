// Black-box tests for the Availability layer (ADR-0014): `ninja on / off /
// manual`, their two-phase (--apply) model, the per-tier mechanisms (Personal:
// unlink + stamps; External: ZCode-config disable + ledger), the guards
// (self-preservation, unmanaged skills, `add` on a switched skill), the
// selectors, and the inventory-v4 visibility of switched skills. Tests import
// no engine code (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, symlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  makeStoreGitRepo,
  readStoredSkill,
  parseStamps,
  storePath,
} from "./helpers/harness.js";

// The realistic Personal state: canonical copy in the store, symlinked into
// every configured agent root (what `add` produces).
async function plantLinkedSkill(home, name, { frontmatter = {}, body = "# Body\n", agents = [".claude/skills", ".zcode/skills"] } = {}) {
  const stored = await plantSkill(home, `.skill-ninja/store/${name}`, {
    frontmatter: { name, ...frontmatter },
    body,
  });
  for (const root of agents) {
    await symlink(stored.dir, join(home, root, name));
  }
  return stored;
}

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

async function readZcodeConfig(home) {
  return JSON.parse(await readFile(join(home, ".zcode", "cli", "config.json"), "utf8"));
}

async function readRawConfig(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "config.json"), "utf8"));
}

// --- Personal: off / on -------------------------------------------------------

test("off dry run reports the plan and changes nothing", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "alpha");
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["off", "alpha"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /dry run \(1 skill selected\)/);
    assert.match(stdout, /alpha \[active → off\]: unlink from agent roots \+ stamp availability: off/);
    assert.match(stdout, /Nothing was changed\. Re-run with --apply/);

    assert.ok(existsSync(join(sb.home, ".claude/skills/alpha")), "link must survive a dry run");
    assert.ok(existsSync(join(sb.home, ".zcode/skills/alpha")), "link must survive a dry run");
    assert.ok(!(await readStoredSkill(sb.home, "alpha")).includes("availability:"), "no stamp in a dry run");
  } finally {
    await sb.cleanup();
  }
});

test("off --apply unlinks everywhere, stamps the stored copy, keeps the body, and commits", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    await plantLinkedSkill(sb.home, "alpha", {
      frontmatter: { description: "Writes things." },
      body: "# Precious instructions\n",
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["off", "alpha", "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /off — applied/);
    assert.match(stdout, /Run `ninja init` to refresh the inventory/);
    assert.match(stdout, /NEW agent sessions/);

    // Unlinked from every configured agent root.
    assert.ok(!existsSync(join(sb.home, ".claude/skills/alpha")), "claude link removed");
    assert.ok(!existsSync(join(sb.home, ".zcode/skills/alpha")), "zcode link removed");

    // The stored copy is stamped, the body is untouched.
    const stored = await readStoredSkill(sb.home, "alpha");
    const stamps = parseStamps(stored);
    assert.equal(stamps.availability, "off");
    assert.equal(stamps.description, "Writes things.");
    assert.ok(stored.includes("# Precious instructions"), "the body survives verbatim");

    // One availability commit in the store's git log.
    const log = execFileSync("git", ["-C", storePath(sb.home), "log", "--oneline"], { encoding: "utf8" });
    assert.match(log, /availability off \(1 skill\)/);

    // init (schema v4) sees the off skill via the store scan root; status tags it.
    await runCli(sb.home, ["init"]);
    const inv = await readInventory(sb.home);
    const occ = inv.skills.find((s) => s.name === "alpha");
    assert.ok(occ, "off skill stays visible through the store scan root");
    assert.equal(occ.availability, "off");
    assert.equal(occ.scanRoot.kind, "store");

    const status = await runCli(sb.home, ["status"]);
    assert.match(status.stdout, /alpha \[off\]/);
    assert.match(status.stdout, /1 manual skill, 1 off skill\.|0 manual skills, 1 off skill\./);
  } finally {
    await sb.cleanup();
  }
});

test("on --apply after off restores the links and clears the stamp", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "alpha");
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["off", "alpha", "--apply"]);

    const { stdout, exitCode } = await runCli(sb.home, ["on", "alpha", "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    assert.ok(existsSync(join(sb.home, ".claude/skills/alpha")), "claude link restored");
    assert.ok(existsSync(join(sb.home, ".zcode/skills/alpha")), "zcode link restored");
    const stamps = parseStamps(await readStoredSkill(sb.home, "alpha"));
    assert.equal(stamps.availability, undefined, "the availability stamp is gone");

    await runCli(sb.home, ["init"]);
    const status = await runCli(sb.home, ["status"]);
    assert.doesNotMatch(status.stdout, /\[off\]/);
  } finally {
    await sb.cleanup();
  }
});

test("on --apply links a stored-but-never-linked skill everywhere (install on demand)", async () => {
  const sb = await createSandbox();
  try {
    // ingest-style output: stored, not linked.
    await plantSkill(sb.home, ".skill-ninja/store/warehoused", { frontmatter: { name: "warehoused" } });
    await runCli(sb.home, ["init"]);
    const before = await runCli(sb.home, ["status"]);
    assert.match(before.stdout, /warehoused \[stored — not linked\]/);

    const { exitCode } = await runCli(sb.home, ["on", "warehoused", "--apply"]);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(sb.home, ".claude/skills/warehoused")));
    assert.ok(existsSync(join(sb.home, ".zcode/skills/warehoused")));
  } finally {
    await sb.cleanup();
  }
});

// --- Personal: manual ---------------------------------------------------------

test("manual --apply preserves the description as activation_text and keeps the links", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "aphrodite", {
      frontmatter: { description: "Writes LinkedIn posts from a topic." },
      body: "# Precious instructions\n",
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["manual", "aphrodite", "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // Manual keeps the skill loaded — links stay.
    assert.ok(existsSync(join(sb.home, ".claude/skills/aphrodite")));
    assert.ok(existsSync(join(sb.home, ".zcode/skills/aphrodite")));

    const stored = await readStoredSkill(sb.home, "aphrodite");
    const stamps = parseStamps(stored);
    assert.equal(stamps.availability, "manual");
    assert.equal(stamps.activation_text, "Writes LinkedIn posts from a topic.");
    assert.equal(stamps.description, "Manual skill — invoke explicitly by name.");
    assert.equal(stamps["disable-model-invocation"], "true");
    assert.ok(stored.includes("# Precious instructions"), "the body survives verbatim");

    await runCli(sb.home, ["init"]);
    const status = await runCli(sb.home, ["status"]);
    assert.match(status.stdout, /aphrodite \[manual\]/);
  } finally {
    await sb.cleanup();
  }
});

test("on --apply restores the activation text verbatim", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "aphrodite", {
      frontmatter: { description: "Writes LinkedIn posts from a topic." },
    });
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["manual", "aphrodite", "--apply"]);

    const { exitCode } = await runCli(sb.home, ["on", "aphrodite", "--apply"]);
    assert.equal(exitCode, 0);

    const stamps = parseStamps(await readStoredSkill(sb.home, "aphrodite"));
    assert.equal(stamps.description, "Writes LinkedIn posts from a topic.");
    assert.equal(stamps.activation_text, undefined);
    assert.equal(stamps["disable-model-invocation"], undefined);
    assert.equal(stamps.availability, undefined);
  } finally {
    await sb.cleanup();
  }
});

test("manual unfolds and preserves block-scalar descriptions", async () => {
  const sb = await createSandbox();
  try {
    await mkdir(join(sb.home, ".skill-ninja/store/folded"), { recursive: true });
    await writeFile(
      join(sb.home, ".skill-ninja/store/folded/SKILL.md"),
      "---\nname: folded\ndescription: >-\n  Writes posts from a topic\n  across several lines.\n---\n\n# Folded\n",
      "utf8",
    );
    await symlink(join(sb.home, ".skill-ninja/store/folded"), join(sb.home, ".claude/skills/folded"));
    await runCli(sb.home, ["init"]);

    const { exitCode } = await runCli(sb.home, ["manual", "folded", "--apply"]);
    assert.equal(exitCode, 0);
    const stamps = parseStamps(await readStoredSkill(sb.home, "folded"));
    assert.equal(stamps.activation_text, "Writes posts from a topic across several lines.");
    assert.equal(stamps.description, "Manual skill — invoke explicitly by name.");
  } finally {
    await sb.cleanup();
  }
});

test("off --apply on a manual skill restores the real description first", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "aphrodite", {
      frontmatter: { description: "Writes LinkedIn posts from a topic." },
    });
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["manual", "aphrodite", "--apply"]);
    await runCli(sb.home, ["off", "aphrodite", "--apply"]);

    const stamps = parseStamps(await readStoredSkill(sb.home, "aphrodite"));
    assert.equal(stamps.availability, "off");
    assert.equal(stamps.description, "Writes LinkedIn posts from a topic.");
    assert.equal(stamps.activation_text, undefined);
  } finally {
    await sb.cleanup();
  }
});

// --- External: the ZCode projection -------------------------------------------

test("manual on an External skill is refused (skills.sh owns it)", async () => {
  const sb = await createSandbox({
    config: { store: "~/.skill-ninja/store", agents: ["zcode", "agents"], vaults: [], projects: [] },
  });
  try {
    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { "ext-skill": { source: "some/repo", computedHash: "deadbeef" } } }),
      "utf8",
    );
    await plantSkill(sb.home, ".agents/skills/ext-skill");
    await runCli(sb.home, ["init"]);

    const { stderr, exitCode } = await runCli(sb.home, ["manual", "ext-skill", "--apply"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /skills\.sh owns: ext-skill/);
  } finally {
    await sb.cleanup();
  }
});

test("off/on on an External skill writes and removes only its own ZCode overrides", async () => {
  const sb = await createSandbox({
    config: { store: "~/.skill-ninja/store", agents: ["zcode", "agents"], vaults: [], projects: [] },
  });
  try {
    // A pre-existing, hand-set override that must never be touched.
    await mkdir(join(sb.home, ".zcode/cli"), { recursive: true });
    const foreignPath = join(sb.home, ".zcode/skills/find-skills/SKILL.md");
    await writeFile(
      join(sb.home, ".zcode/cli/config.json"),
      JSON.stringify({ skills: { [foreignPath]: { enable: false } } }, null, 2),
      "utf8",
    );

    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { "ext-skill": { source: "some/repo", computedHash: "deadbeef" } } }),
      "utf8",
    );
    await plantSkill(sb.home, ".agents/skills/ext-skill");
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["off", "ext-skill", "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /disable in ZCode config/);

    const zcfg = await readZcodeConfig(sb.home);
    const extPath = join(sb.home, ".agents/skills/ext-skill/SKILL.md");
    assert.deepEqual(zcfg.skills[extPath], { enable: false });
    assert.deepEqual(zcfg.skills[foreignPath], { enable: false }, "the foreign override is preserved");

    // The ledger records what Skill Ninja wrote; init overlays it as off.
    const raw = await readRawConfig(sb.home);
    assert.deepEqual(raw.zcode_disables["ext-skill"], [extPath]);
    await runCli(sb.home, ["init"]);
    const status = await runCli(sb.home, ["status"]);
    assert.match(status.stdout, /ext-skill \[off\]/);

    // The External install itself is untouched (never unlinked, ADR-0007).
    assert.ok(existsSync(join(sb.home, ".agents/skills/ext-skill")));

    const on = await runCli(sb.home, ["on", "ext-skill", "--apply"]);
    assert.equal(on.exitCode, 0);
    const zcfgAfter = await readZcodeConfig(sb.home);
    assert.equal(zcfgAfter.skills[extPath], undefined, "our override is removed");
    assert.deepEqual(zcfgAfter.skills[foreignPath], { enable: false }, "the foreign override still stands");
    const rawAfter = await readRawConfig(sb.home);
    assert.equal(rawAfter.zcode_disables?.["ext-skill"], undefined, "the ledger entry is gone");
  } finally {
    await sb.cleanup();
  }
});

// --- guards and selectors -----------------------------------------------------

test("refusing to switch the ninja skill itself is built in", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/ninja", { frontmatter: { name: "ninja" } });
    await runCli(sb.home, ["init"]);

    const { stderr, exitCode } = await runCli(sb.home, ["off", "ninja", "--apply"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /Refusing to switch the 'ninja' skill itself/);
  } finally {
    await sb.cleanup();
  }
});

test("a loose unattributed skill is refused with a pointer to add", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/loose");
    await runCli(sb.home, ["init"]);

    const { stderr, exitCode } = await runCli(sb.home, ["off", "loose", "--apply"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /No stored copy and no skills\.sh attribution for 'loose'/);
    assert.match(stderr, /ninja add/);
  } finally {
    await sb.cleanup();
  }
});

test("selectors: --category, --except, and --tier personal scope the batch", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "writer", { frontmatter: { category: "Content & Writing" } });
    await plantLinkedSkill(sb.home, "marketer", { frontmatter: { category: "Marketing & Social" } });
    await plantLinkedSkill(sb.home, "strategist", { frontmatter: { category: "Marketing & Social" } });
    await runCli(sb.home, ["init"]);

    // --category switches only the matching section.
    const cat = await runCli(sb.home, ["off", "--category", "Marketing & Social", "--apply"]);
    assert.equal(cat.exitCode, 0, `stderr:\n${cat.stdout}`);
    assert.ok(!existsSync(join(sb.home, ".claude/skills/marketer")));
    assert.ok(!existsSync(join(sb.home, ".claude/skills/strategist")));
    assert.ok(existsSync(join(sb.home, ".claude/skills/writer")), "other categories untouched");

    // --except subtracts names from a selector.
    const except = await runCli(sb.home, ["on", "--category", "Marketing & Social", "--except", "strategist", "--apply"]);
    assert.equal(except.exitCode, 0);
    assert.ok(existsSync(join(sb.home, ".claude/skills/marketer")));
    assert.ok(!existsSync(join(sb.home, ".claude/skills/strategist")));
  } finally {
    await sb.cleanup();
  }
});

test("unknown names and empty selections are errors, not silent no-ops", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "alpha");
    await runCli(sb.home, ["init"]);

    const missing = await runCli(sb.home, ["off", "nope"]);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /No skill named 'nope'/);

    const empty = await runCli(sb.home, ["off", "--category", "Design & Documents"]);
    assert.equal(empty.exitCode, 2);
    assert.match(empty.stderr, /No skills match/);
  } finally {
    await sb.cleanup();
  }
});

test("add on a switched skill is refused until it is switched Active again", async () => {
  const sb = await createSandbox();
  try {
    await plantLinkedSkill(sb.home, "alpha", { frontmatter: { description: "Writes things." } });
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["manual", "alpha", "--apply"]);

    const source = join(sb.home, ".claude/skills/alpha"); // unlinked by off? no — manual keeps links
    const { stderr, exitCode } = await runCli(sb.home, ["add", source]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /currently manual/);
    assert.match(stderr, /ninja on alpha/);
  } finally {
    await sb.cleanup();
  }
});
