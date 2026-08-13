#!/usr/bin/env node
// Skill Ninja engine — CLI entry point.
//
// The skill (SKILL.md) is the interface the agent drives via slash commands;
// this engine does the deterministic work (SPEC.md: hybrid form factor). It
// dispatches `skill-ninja <command>` to a command handler.
import { homedir } from "node:os";

import { configPath, loadConfig } from "./config.js";
import { agentRoot } from "./agents.js";

// The full command surface the skill exposes. Only `config` is wired in this
// build (T1 skeleton); the rest are documented here so the CLI and SKILL.md
// agree on the interface, and report "not implemented yet" rather than
// "unknown command" when invoked.
const COMMANDS = {
  init: "Analyze the machine: discover agent roots, vaults, and skills.",
  status: "One inventory view of every skill across agents and vaults.",
  doctor: "Detect and repair problems (broken links, duplicates, orphans).",
  add: "Ingest a new skill safely, with provenance recorded.",
  diff: "Show what changed in a skill since the stored version.",
  config: "Show Skill Ninja's configuration (try: config show).",
};

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
  lines.push("", "vaults:");
  if (config.vaults.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const vault of config.vaults) {
      lines.push(`  ${vault}`);
    }
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
  process.stderr.write("Try: skill-ninja config show\n");
  return 2;
}

async function dispatch(argv) {
  const [command, ...rest] = argv;
  if (command === "config") {
    return configCommand(rest);
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
