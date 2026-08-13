#!/usr/bin/env node
// Skill Ninja engine — CLI entry point.
//
// The skill (SKILL.md) is the interface the agent drives via slash commands;
// this engine does the deterministic work (SPEC.md: hybrid form factor). It
// dispatches `skill-ninja <command>` to a command handler.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { configPath, loadConfig } from "./config.js";
import { agentRoot } from "./agents.js";
import { buildInventory, writeInventory, inventoryPath } from "./inventory.js";
import { renderStatus } from "./status.js";
import { addCommand } from "./add.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";

// The full command surface the skill exposes. Every command is wired to a
// handler; COMMANDS also drives `help` so the CLI and SKILL.md agree on the
// interface. (An entry here with no handler would report "not implemented yet"
// rather than "unknown command" — a defensive guard for future surfaces.)
const COMMANDS = {
  init: "Analyze the machine: discover agent roots, vaults, and skills.",
  status: "One inventory view of every skill across agents and vaults.",
  doctor: "Detect and repair problems (broken links, duplicates, orphans).",
  add: "Ingest a new skill safely, with provenance recorded.",
  diff: "Show what changed in a skill since the stored version.",
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
  const lines = ["Usage: skill-ninja <command> [args]", "", "Commands:"];
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
          "Run `skill-ninja init` to analyze your machine and create one.\n",
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
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function configCommand(args) {
  const [sub] = args;
  if (sub === "show" || sub === undefined) {
    return showConfig();
  }
  process.stderr.write(`Unknown config subcommand: ${sub}\n`);
  process.stderr.write("Try: skill-ninja config show\n");
  return 2;
}

// init — analyze the machine: scan every configured scope (agent roots, vaults,
// project dirs), discover skills, detect version/provenance, record broken
// symlinks, write the cached inventory, and print a summary. (ADR-0003.)
function printInitSummary(inventory, cachePath) {
  const { counts } = inventory;
  const scopeWord = counts.scopes === 1 ? "scope" : "scopes";
  const skillWord = counts.skills === 1 ? "skill" : "skills";
  const brokenWord = counts.broken === 1 ? "broken symlink" : "broken symlinks";
  const lines = [
    `Skill Ninja init — scanned ${counts.scopes} ${scopeWord}.`,
    `Discovered ${counts.skills} ${skillWord}, ${counts.broken} ${brokenWord}.`,
  ];
  const keys = Object.keys(counts.byScope);
  if (keys.length > 0) {
    lines.push("");
    const width = Math.max(...keys.map((k) => k.length));
    for (const k of keys) lines.push(`  ${k.padEnd(width)}  ${counts.byScope[k]}`);
  }
  lines.push("", `Inventory written to ${cachePath}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function initCommand() {
  const home = homedir();
  let inventory;
  try {
    inventory = await buildInventory(home);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      process.stdout.write(
        `No Skill Ninja configuration found at ${configPath(home)}.\n` +
          "Create ~/.skill-ninja/config.json with your agents, vaults, and projects, then re-run `init`.\n",
      );
      return 0;
    }
    throw err;
  }
  const cachePath = await writeInventory(inventory, home);
  printInitSummary(inventory, cachePath);
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
      process.stderr.write("Try: skill-ninja status [--broken] [--duplicates] [--personal]\n");
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
          "Run `skill-ninja init` to scan your skills, then re-run `status`.\n",
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
    return initCommand();
  }
  if (command === "status") {
    return statusCommand(rest);
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
