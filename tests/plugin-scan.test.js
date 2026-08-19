// Black-box tests for plugin-cache discovery (ADR-0018): skills bundled inside
// agent plugins are discovered, attributed, and audited — never managed. The
// Agent Plugins 1.0.0 layout (plugin.json + skills/) is covered alongside the
// pre-spec plugin cache conventions (.zcode-plugin-seed.json, package.json).
// Tests plant plugin caches in a sandboxed fake $HOME, run the CLI, and assert
// on stdout + the written inventory cache file. They never import engine code
// (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

// Write a JSON fixture at <home>/<rel> (creating parent dirs).
async function writeJson(home, rel, obj) {
  const path = join(home, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return path;
}

// Plant an Agent Plugins 1.0.0 plugin (the spec layout: plugin.json manifest,
// skills/ subtree, plus non-skill plugin content that must be ignored).
// `extra` receives the plugin dir (relative to home) for additional skills.
async function plantAgentPlugin(home, { rel, name, versions = ["1.0.0"], skills, malformed = false, extra = null }) {
  for (const v of versions) {
    const dir = join(rel, v);
    const manifest = malformed
      ? `{"name": ` // deliberately unparseable — boundary must still bound
      : { $schema: "https://agentplugins.dev/schema/agent-plugins-v1.json", name };
    const path = join(home, dir, "plugin.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2), "utf8");
    for (const skill of skills) {
      await plantSkill(home, join(dir, "skills", skill), { frontmatter: { name: skill } });
    }
    // Non-skill plugin content: an MCP server declaration and a client-specific
    // reverse-domain dir holding a stray SKILL.md — neither is skill content
    // (Agent Plugins 1.0.0: skills live in skills/, only).
    await writeJson(home, join(dir, "mcp.json"), {
      mcpServers: { reports: { type: "stdio", command: "reports-server" } },
    });
    await plantSkill(home, join(dir, "com.example.claude", "notes"));
    if (extra) await extra(dir);
  }
}

// Slice A — a plugin in the Agent Plugins 1.0.0 layout is discovered inside the
// agent's plugin cache, attributed to its manifest name, and reported as
// plugin-owned; the mcp.json and the com.example.* client dir contribute nothing.
test("init discovers an Agent Plugins 1.0.0 plugin and tags its skills plugin-owned", async () => {
  const sb = await createSandbox();
  try {
    await plantAgentPlugin(sb.home, {
      rel: ".claude/plugins/cache/acme/report-tools",
      name: "report-tools",
      skills: ["summarize"],
    });

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    assert.equal(cache.counts.skills, 1, `expected exactly the bundled skill, got:\n${JSON.stringify(cache.skills)}`);
    const found = cache.skills.find((s) => s.name === "summarize");
    assert.ok(found, `expected summarize in inventory, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.tier, "plugin");
    assert.equal(found.plugin, "report-tools");
    assert.equal(found.scanRoot.kind, "plugin");
    assert.equal(found.scanRoot.ref, "claude");
    assert.equal(found.scanRoot.root, join(sb.home, ".claude", "plugins", "cache"));

    const { stdout } = await runCli(sb.home, ["status"]);
    assert.ok(stdout.includes("Claude plugins"), `expected the plugin scan-root label, got:\n${stdout}`);
    assert.ok(
      stdout.includes("plugin-bundled in 'report-tools'"),
      `expected plugin attribution in provenance, got:\n${stdout}`,
    );
    assert.ok(!stdout.includes("notes"), `the com.example.* stray skill must not surface, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice B — the ZCode pre-spec cache convention: no plugin.json, attribution
// from .zcode-plugin-seed.json (whose `plugin` field outranks package.json).
test("init discovers a ZCode plugin-cache skill and attributes it from the seed manifest", async () => {
  const sb = await createSandbox();
  try {
    const dir = ".zcode/cli/plugins/cache/zcode-plugins-official/document-kit/0.1.0";
    await writeJson(sb.home, join(dir, ".zcode-plugin-seed.json"), {
      marketplace: "zcode-plugins-official",
      plugin: "document-kit",
      pluginVersion: "0.1.0",
    });
    await writeJson(sb.home, join(dir, "package.json"), { name: "@zcode/document-kit-plugin" });
    await plantSkill(sb.home, join(dir, "skills", "docx"), { frontmatter: { name: "docx" } });

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "docx");
    assert.ok(found, `expected docx in inventory, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.tier, "plugin");
    assert.equal(found.plugin, "document-kit", "seed's `plugin` field must outrank package.json's scoped name");
    assert.equal(found.scanRoot.kind, "plugin");
    assert.equal(found.scanRoot.ref, "zcode");

    const { stdout } = await runCli(sb.home, ["status"]);
    assert.ok(stdout.includes("ZCode plugins"), `expected the plugin scan-root label, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — a plugin cache legitimately holding several versions of the same
// bundled skill is the plugin manager's spread, not a Skill Ninja duplicate.
test("status does not flag a plugin's own version spread as a duplicate", async () => {
  const sb = await createSandbox();
  try {
    await plantAgentPlugin(sb.home, {
      rel: ".claude/plugins/cache/acme/report-tools",
      name: "report-tools",
      versions: ["1.0.0", "1.1.0"],
      skills: ["greet"],
    });

    await runCli(sb.home, ["init"]);
    const cache = await readInventory(sb.home);
    const occurrences = cache.skills.filter((s) => s.name === "greet");
    assert.equal(occurrences.length, 2, "both cached versions are physical occurrences");

    const { stdout } = await runCli(sb.home, ["status"]);
    assert.ok(stdout.includes("greet"), `expected greet in status, got:\n${stdout}`);
    assert.ok(!stdout.includes("[duplicate]"), `a plugin version spread is not a duplicate, got:\n${stdout}`);
    assert.match(stdout, /0 duplicated skills/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice D — a personal copy plus a plugin-bundled copy of the same name:
// `status` flags the duplicate (the user holds it twice, worth seeing), but
// `doctor` proposes no repair — plugin-owned occurrences are audit-only.
test("doctor never proposes a repair touching a plugin-bundled skill", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".skill-ninja/store/docx", { frontmatter: { name: "docx" } });
    const dir = ".zcode/cli/plugins/cache/zcode-plugins-official/document-kit/0.1.0";
    await writeJson(sb.home, join(dir, ".zcode-plugin-seed.json"), { plugin: "document-kit" });
    await plantSkill(sb.home, join(dir, "skills", "docx"), { frontmatter: { name: "docx" } });

    await runCli(sb.home, ["init"]);

    const status = await runCli(sb.home, ["status"]);
    assert.ok(
      status.stdout.includes("[duplicate]"),
      `a mixed personal+plugin spread stays visible as a duplicate, got:\n${status.stdout}`,
    );

    const doctor = await runCli(sb.home, ["doctor"]);
    assert.equal(doctor.exitCode, 0);
    assert.ok(
      doctor.stdout.includes("No problems detected"),
      `doctor must not propose repairs for a plugin-owned spread, got:\n${doctor.stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice E — availability switches refuse plugin-bundled skills: the plugin
// cache is the plugin manager's; a stamp or unlink there would be reverted on
// the next plugin update (ADR-0018).
test("on/off/manual refuse a plugin-bundled skill", async () => {
  const sb = await createSandbox();
  try {
    await plantAgentPlugin(sb.home, {
      rel: ".claude/plugins/cache/acme/report-tools",
      name: "report-tools",
      skills: ["summarize"],
    });
    await runCli(sb.home, ["init"]);

    const off = await runCli(sb.home, ["off", "summarize"]);
    assert.equal(off.exitCode, 2);
    assert.match(
      off.stderr,
      /Plugin-bundled skills are managed by the agent's plugin system/,
      `expected the plugin refusal, got:\n${off.stderr}`,
    );

    const on = await runCli(sb.home, ["on", "summarize"]);
    assert.equal(on.exitCode, 2);
    assert.match(on.stderr, /plugin system/, `got:\n${on.stderr}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice F — a malformed plugin.json still bounds the plugin (attribution falls
// back to the directory basename); discovery never fails on a bad manifest.
test("a malformed plugin.json bounds the plugin with the directory basename", async () => {
  const sb = await createSandbox();
  try {
    await plantAgentPlugin(sb.home, {
      rel: ".claude/plugins/cache/acme/report-tools",
      name: "ignored-name",
      skills: ["summarize"],
      malformed: true,
    });

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "summarize");
    assert.ok(found, `expected summarize in inventory, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.tier, "plugin");
    assert.equal(found.plugin, "report-tools", "falls back to the plugin directory's basename");
  } finally {
    await sb.cleanup();
  }
});

// Slice G — a skills/ subtree with no manifest at all (a loose bundle dropped
// into the cache) is still plugin-tier territory: audited, attributed nameless.
test("a manifest-less bundle in the plugin cache is discovered as plugin-owned", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/plugins/cache/stray-bundle/skills/thing", {
      frontmatter: { name: "thing" },
    });

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "thing");
    assert.ok(found, `expected thing in inventory, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.tier, "plugin");
    assert.equal(found.plugin, null);

    const { stdout } = await runCli(sb.home, ["status"]);
    assert.ok(stdout.includes("plugin-bundled"), `nameless attribution still reads as plugin-bundled, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});
