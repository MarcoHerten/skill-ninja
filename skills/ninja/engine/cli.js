#!/usr/bin/env node
// Skill Ninja engine — CLI entry point.
//
// The skill (SKILL.md) is the interface the agent drives via slash commands;
// this engine does the deterministic work (SPEC.md: hybrid form factor). It
// dispatches `ninja <command>` to a command handler.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { configPath, loadConfig, readRawConfig, normalizeNameLists } from "./config.js";
import { agentRoot } from "./agents.js";
import { buildInventory, writeInventory, inventoryPath } from "./inventory.js";
import { bootstrapConfig, seedConfig, ensureStore, resolveStoreArg } from "./discover.js";
import {
  writeStoreList,
  commitStoreList,
  COLLECTIONS_FILE,
  PROFILES_FILE,
} from "./storelists.js";
import { renderStatus } from "./status.js";
import { pageCommand } from "./page.js";
import { catCommand, resolveVocabulary } from "./cat.js";
import { addCommand } from "./add.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";
import { ingestCommand } from "./ingest.js";
import { availabilityCommand } from "./availability.js";
import { findCommand } from "./find.js";
import { profileCommand } from "./profile.js";
import { collectionCommand } from "./collection.js";

// The full command surface the skill exposes. Every command is wired to a
// handler; COMMANDS also drives `help` so the CLI and SKILL.md agree on the
// interface. (An entry here with no handler would report "not implemented yet"
// rather than "unknown command" — a defensive guard for future surfaces.)
const COMMANDS = {
  init: "Analyze the machine: discover agent roots, vaults, and skills (--store <name|path> selects the canonical store).",
  status: "One inventory view of every skill across agents and vaults.",
  cat: "Browse skills as a catalog grouped by category; assign stamps the stored copy.",
  page: "Render the cached inventory as a self-contained static HTML status page.",
  doctor: "Detect and repair problems (broken links, duplicates, orphans).",
  add: "Ingest a new skill safely, with provenance recorded.",
  diff: "Show what changed in a skill since the stored version.",
  ingest: "Analyze a directory of skills/prompts: classify, cluster, propose winners (--apply stores them in one commit).",
  on: "Switch skills Active: link into agent roots (dry run; --apply executes).",
  off: "Switch skills Off: unload everywhere (dry run; --apply executes).",
  manual: "Switch skills Manual: invocable by name, never auto-triggered (dry run; --apply executes).",
  find: "Search the cached inventory by skill name, description, or category.",
  profile: "Manage skill profiles: list | save | forget | apply | lift.",
  collection: "Manage personal collections (filters that travel with the store): list | save | forget — use with cat @<name>.",
  config: "Show Skill Ninja's configuration (try: config show).",
};

// Push a titled list section ("name:" + one indented item per entry, or
// "(none configured)") onto the output lines. Used for vaults / projects.
function pushListSection(lines, title, items) {
  lines.push("", `${title}:`);
  if (items.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const item of items) lines.push(`  ${item}`);
  }
}

function printUsage(stream) {
  const lines = ["Usage: ninja <command> [args]", "", "Commands:"];
  for (const [name, desc] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(8)} ${desc}`);
  }
  stream.write(lines.join("\n") + "\n");
}

async function showConfig() {
  const home = homedir();
  let config;
  try {
    config = await loadConfig(home);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      process.stdout.write(
        `No Skill Ninja configuration found at ${configPath(home)}.\n` +
          "Run `ninja init` to analyze your machine and create one.\n",
      );
      return 0;
    }
    throw err;
  }

  const lines = ["Skill Ninja configuration", ""];
  lines.push(`canonical store: ${config.store ?? "(unset)"}`);
  lines.push("", "agents:");
  if (config.agents.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const key of config.agents) {
      const root = agentRoot(key, home);
      lines.push(`  ${key} -> ${root ?? "(unknown agent)"}`);
    }
  }
  pushListSection(lines, "vaults", config.vaults);
  pushListSection(lines, "projects", config.projects);
  // The category vocabulary (Issue #10): the configured list when one is set,
  // else a pointer to the engine defaults so the vocabulary stays discoverable.
  const categories = resolveVocabulary(config);
  const configured = Array.isArray(config.categories);
  lines.push("", "categories:");
  if (!configured) {
    lines.push("  (engine defaults — see `ninja cat`)");
  } else if (categories.length === 0) {
    lines.push("  (configured empty — every category is custom)");
  } else {
    for (const c of categories) lines.push(`  ${c}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function configCommand(args) {
  const [sub] = args;
  if (sub === "show" || sub === undefined) {
    return showConfig();
  }
  process.stderr.write(`Unknown config subcommand: ${sub}\n`);
  process.stderr.write("Try: ninja config show\n");
  return 2;
}

// init — analyze the machine: scan every configured scan root (agent roots,
// vaults, project dirs), discover skills, detect version/provenance, record
// broken symlinks, write the cached inventory, and print a summary. (ADR-0003.)
function printInitSummary(inventory, cachePath) {
  const { counts } = inventory;
  const scanRootWord = counts.scanRoots === 1 ? "scan root" : "scan roots";
  const skillWord = counts.skills === 1 ? "skill" : "skills";
  const brokenWord = counts.broken === 1 ? "broken symlink" : "broken symlinks";
  const lines = [
    `Skill Ninja init — scanned ${counts.scanRoots} ${scanRootWord}.`,
    `Discovered ${counts.skills} ${skillWord}, ${counts.broken} ${brokenWord}.`,
  ];
  const keys = Object.keys(counts.byScanRoot);
  if (keys.length > 0) {
    lines.push("");
    const width = Math.max(...keys.map((k) => k.length));
    for (const k of keys) lines.push(`  ${k.padEnd(width)}  ${counts.byScanRoot[k]}`);
  }
  lines.push("", `Inventory written to ${cachePath}`);
  process.stdout.write(lines.join("\n") + "\n");
}

// init — the single front door (ADR-0008). On a fresh machine it needs NO
// pre-existing config: it discovers the landscape, seeds ~/.skill-ninja/
// config.json, creates the canonical store (+ git init), then scans. Re-running
// re-discovers and re-seeds (how config gets edited). Phases: discover → seed →
// scan.

// `init` accepts exactly one option: `--store <name|path>` (ADR-0016). Any
// other argument — or an empty --store value — is a usage error (exit 2).
function parseInitArgs(argv) {
  const opts = { store: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") {
      const value = argv[++i];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        return { error: "--store needs a value: a bare name or a path (e.g. skill-vault, ~/code/skill-store)" };
      }
      opts.store = value;
    } else if (a.startsWith("--store=")) {
      const value = a.slice("--store=".length);
      if (value === "") {
        return { error: "--store needs a value: a bare name or a path (e.g. skill-vault, ~/code/skill-store)" };
      }
      opts.store = value;
    } else {
      return { error: `unknown init argument: ${a}` };
    }
  }
  return opts;
}

// The currently configured store (expanded), or null when no config exists —
// the `init --store` switch report only fires against a real previous store.
async function configuredStore(home) {
  try {
    return (await loadConfig(home)).store;
  } catch {
    return null;
  }
}

async function initCommand(args) {
  const home = homedir();
  const opts = parseInitArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nTry: ninja init [--store <name|path>]\n`);
    return 2;
  }
  // An explicit --store overrides the configured store for this run and is
  // persisted as `store` in the seeded config (ADR-0016); without the flag the
  // no-clobber rule applies unchanged.
  let storeOverride = null;
  let previousStore = null;
  if (opts.store !== null) {
    storeOverride = resolveStoreArg(opts.store, home);
    previousStore = await configuredStore(home);
  }
  // ADR-0017: collections/profiles live store-side now. Capture any
  // config-side lists from a pre-v1.5 setup BEFORE re-seeding overwrites the
  // config — they migrate into the store files below.
  const previousRaw = await readRawConfig(home);
  // DISCOVER + SEED: build/refresh the config from detection and write it.
  const config = await bootstrapConfig(home, storeOverride);
  await seedConfig(home, config);
  // Re-read the seeded config so `~` paths are expanded into absolute ones.
  const resolved = await loadConfig(home);
  // Canonical store + git init (first run works without a remote).
  await ensureStore(resolved.store);
  // One-time list migration (ADR-0017): move captured config-side lists into
  // the store files — only where no file exists yet, so a store that already
  // traveled with a clone is never clobbered by stale local config.
  const migrated = [];
  if (previousRaw) {
    for (const [key, file, label] of [
      ["collections", COLLECTIONS_FILE, "collections"],
      ["profiles", PROFILES_FILE, "profiles"],
    ]) {
      const lists = normalizeNameLists(previousRaw[key]);
      if (Object.keys(lists).length > 0 && !existsSync(join(resolved.store, file))) {
        await writeStoreList(resolved.store, file, lists);
        commitStoreList(resolved.store, file, `migrate ${label} to store`);
        migrated.push(label);
      }
    }
  }
  // SCAN: the config now exists; build + cache the inventory from it.
  const inventory = await buildInventory(home);
  const cachePath = await writeInventory(inventory, home);
  printInitSummary(inventory, cachePath);
  // Switch report (ADR-0016): pointing --store away from a previous store that
  // still exists leaves that store untouched — nothing is ever moved.
  if (previousStore && previousStore !== resolved.store && existsSync(previousStore)) {
    process.stdout.write(
      `\nPrevious store left untouched at ${previousStore} — its skills, links, and history remain there; nothing was moved or copied.\n`,
    );
  }
  if (migrated.length > 0) {
    process.stdout.write(
      `\nMigrated ${migrated.join(" and ")} from config.json into the store — they travel with the store repo now.\n`,
    );
  }
  return 0;
}

// status — one readable inventory view. Reads the cached inventory written by
// `init` (it does NOT re-scan); groups occurrences by name to surface
// duplicates and tool-asymmetry spread; flags broken symlinks distinctly; shows
// version/provenance where known; applies filters. (Issue #4.)
function parseStatusFlags(argv) {
  const flags = { broken: false, duplicates: false, personal: false };
  for (const a of argv) {
    if (a === "--broken") flags.broken = true;
    else if (a === "--duplicates") flags.duplicates = true;
    else if (a === "--personal") flags.personal = true;
    else {
      process.stderr.write(`Unknown status flag: ${a}\n`);
      process.stderr.write("Try: ninja status [--broken] [--duplicates] [--personal]\n");
      return null;
    }
  }
  return flags;
}

async function statusCommand(args) {
  const flags = parseStatusFlags(args);
  if (!flags) return 2;

  const home = homedir();
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      process.stdout.write(
        `No Skill Ninja inventory found at ${inventoryPath(home)}.\n` +
          "Run `ninja init` to scan your skills, then re-run `status`.\n",
      );
      return 0;
    }
    throw err;
  }
  const inventory = JSON.parse(raw);

  // Config feeds the --personal heuristic (the canonical store path). If the
  // config has vanished since init, fall back to store=null so personal is
  // decided by provenance alone.
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

  process.stdout.write(renderStatus(inventory, config, flags));
  return 0;
}

async function dispatch(argv) {
  const [command, ...rest] = argv;
  if (command === "config") {
    return configCommand(rest);
  }
  if (command === "init") {
    return initCommand(rest);
  }
  if (command === "status") {
    return statusCommand(rest);
  }
  if (command === "cat") {
    return catCommand(rest);
  }
  if (command === "page") {
    return pageCommand(rest);
  }
  if (command === "add") {
    return addCommand(rest);
  }
  if (command === "diff") {
    return diffCommand(rest);
  }
  if (command === "doctor") {
    return doctorCommand(rest);
  }
  if (command === "ingest") {
    return ingestCommand(rest);
  }
  if (command === "on" || command === "off" || command === "manual") {
    return availabilityCommand(command, rest);
  }
  if (command === "find") {
    return findCommand(rest);
  }
  if (command === "profile") {
    return profileCommand(rest);
  }
  if (command === "collection") {
    return collectionCommand(rest);
  }
  if (command in COMMANDS) {
    // Known command not yet wired in this build.
    process.stdout.write(
      `\`${command}\` is part of the Skill Ninja command surface but is not implemented in this build yet.\n`,
    );
    return 0;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printUsage(process.stdout);
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n`);
  printUsage(process.stderr);
  return 2;
}

const code = await dispatch(process.argv.slice(2));
process.exit(code);
