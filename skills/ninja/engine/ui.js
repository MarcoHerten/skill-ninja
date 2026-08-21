// The Manager UI (ADR-0019) — `/ninja ui`: the interactive, local-only web
// interface. Where `page` renders a static snapshot whose cockpit *proposes*
// commands to copy, the Manager UI operates the engine directly: its buttons
// call JSON endpoints that run the same CLI apply-paths (`on`/`manual`/`off`,
// `profile apply`/`lift`, `init`), edit Notes beside the stored copies, serve
// the three copy flavors, and delegate External-skill removal to skills.sh
// (ADR-0020).
//
// Shape (ADR-0019): a thin adapter, never a second implementation — reads
// come from the cached inventory through the same status/cat helpers `page`
// uses; writes spawn the engine CLI itself, so the two-phase approval model
// survives as an explicit confirm (the frontend first runs the dry-run and
// shows its plan; the click is the `--apply`). The server is loopback-only,
// serves one self-contained page with inline CSS/JS, uses no network, and
// dies with its terminal — it is not a daemon.

import { createServer } from "node:http";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { groupSkills, groupAvailability, scanRootLabel, plural } from "./status.js";
import { groupTier, groupCategory, groupDescription } from "./cat.js";
import { readCollections, collectionsForName } from "./collection.js";
import { readStoreList, PROFILES_FILE } from "./storelists.js";
import { tryCommit, tryPush } from "./git.js";
import { splitFrontmatter } from "./hash.js";
import { renderManagerPage } from "./ui-page.js";

const ENGINE_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

export const DEFAULT_PORT = 4173;
export const NOTE_FILE = "NOTE.md";

// The mutating surface the UI may drive through /api/exec (ADR-0019: the
// server is trusted exactly like the CLI, but only what a button needs is
// reachable — `add`/`ingest`/`doctor` stay CLI/slash-command work).
const EXEC_ALLOWED = new Set(["on", "off", "manual", "profile", "init"]);

const EXEC_TIMEOUT_MS = 180_000;
const NPX_TIMEOUT_MS = 300_000;
const BODY_LIMIT = 1_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// --- state --------------------------------------------------------------------

// The public config subset the page needs — the ledger and other internals
// never leave the engine.
function publicConfig(config) {
  return {
    store: config.store ?? null,
    agents: config.agents ?? [],
    projects: config.projects ?? [],
  };
}

/**
 * Read a skill's Note (CONTEXT.md): the owner's rationale beside the stored
 * copy. "" when the store is unset or no note exists.
 */
export async function readNote(store, name) {
  if (!store) return "";
  try {
    return await readFile(join(store, name, NOTE_FILE), "utf8");
  } catch {
    return "";
  }
}

/**
 * Save (or clear, when the text is blank) a skill's Note and commit it like
 * every other stored-skill change (ADR-0016: the store's history is the
 * per-skill change log).
 * @returns {Promise<{deleted?: boolean, committed?: boolean}>}
 */
export async function saveNote(store, name, text) {
  if (!store || !existsSync(join(store, name, "SKILL.md"))) {
    throw httpError(
      400,
      `No stored skill '${name}' — a Note lives beside the stored copy (run \`ninja add\` first).`,
    );
  }
  const file = join(store, name, NOTE_FILE);
  const value = typeof text === "string" ? text : "";
  if (value.trim() === "") {
    if (existsSync(file)) {
      await rm(file);
      return { deleted: true };
    }
    return {};
  }
  await writeFile(file, value.endsWith("\n") ? value : value + "\n", "utf8");
  const committed = tryCommit(store, [join(name, NOTE_FILE)], `note ${name}`);
  if (committed) tryPush(store);
  return { committed };
}

// The same totals the page header reports (status.js-derived), plus the
// availability split the Manager UI's bulk action reasons about.
function summarizeGroups(groups) {
  return {
    skills: groups.length,
    locations: groups.reduce((n, g) => n + g.locations.length, 0),
    active: groups.filter((g) => g.availability === "active").length,
    manual: groups.filter((g) => g.availability === "manual").length,
    off: groups.filter((g) => g.availability === "off").length,
    stored: groups.filter((g) => g.availability === "stored").length,
  };
}

/**
 * Build the whole UI state from the cached inventory + store-side lists.
 * Reads only — the same sources `status`/`page` read, through the same
 * helpers, so the Manager UI cannot disagree with the CLI views.
 */
export async function buildState(home) {
  let config;
  try {
    config = await loadConfig(home);
  } catch {
    config = { store: null, agents: [], projects: [] };
  }

  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ready: false, reason: "no-inventory", config: publicConfig(config) };
    }
    throw err;
  }
  const inventory = JSON.parse(raw);

  const collections = await readCollections(config);
  const profiles = await readStoreList(config.store, PROFILES_FILE);

  const cards = [];
  for (const group of groupSkills(inventory.skills ?? [])) {
    const tier = groupTier(group.occurrences, config.store);
    cards.push({
      name: group.name,
      tier: tier ? tier.toLowerCase() : "",
      availability: groupAvailability(group),
      category: groupCategory(group) ?? "",
      description: groupDescription(group.occurrences) ?? "",
      collections: collectionsForName(group.name, collections),
      linkedSpread: group.linkedSpread,
      duplicate: group.duplicate && !group.linkedSpread,
      hashDuplicate: group.hashDuplicate,
      note: await readNote(config.store, group.name),
      locations: group.occurrences.map((o) => ({
        label: scanRootLabel(o.scanRoot),
        dir: o.dir,
        resolved: o.symlink ? o.resolved ?? null : null,
        file: o.file,
        kind: o.scanRoot?.kind ?? "",
      })),
    });
  }

  return {
    ready: true,
    generatedAt: inventory.generatedAt ?? null,
    config: publicConfig(config),
    groups: cards,
    profiles,
    collections,
    summary: summarizeGroups(cards),
  };
}

// --- skill payload (raw copy + Chat-Prompt) -------------------------------------

// Where a skill's full text is read from: the stored copy wins (it is the
// canonical one), else the group's first occurrence that still exists.
function skillBodyFile(config, group) {
  if (config.store && existsSync(join(config.store, group.name, "SKILL.md"))) {
    return join(config.store, group.name, "SKILL.md");
  }
  for (const o of group.occurrences) {
    if (o.file && existsSync(o.file)) return o.file;
  }
  return null;
}

// Bundled assets beside the SKILL.md — the Chat-Prompt's warning list.
// CHANGELOG.md and NOTE.md are bookkeeping, not skill assets.
async function listAssets(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => e !== "SKILL.md" && e !== "CHANGELOG.md" && e !== NOTE_FILE).sort();
}

/**
 * Build the Chat-Prompt (CONTEXT.md): the export of a skill as a
 * self-contained prompt for a plain chatbot — role framing, the skill's body
 * without frontmatter, a task placeholder, and a warning when the skill
 * bundles assets a chat cannot read.
 */
export function buildChatPrompt({ name, description, body, assets = [] }) {
  const lines = [
    "Du arbeitest nach der folgenden Skill-Anleitung. Lies sie vollständig, bevor du antwortest, und befolge sie.",
    "",
    `--- SKILL-ANLEITUNG: ${name} ---`,
  ];
  if (description) lines.push(`Zweck: ${description}`, "");
  lines.push(body.trim(), "--- ENDE DER SKILL-ANLEITUNG ---");
  if (assets.length > 0) {
    lines.push(
      "",
      `Hinweis: diese Anleitung referenziert zusätzliche Dateien (${assets.join(", ")}), ` +
        "die in diesem Chat nicht vorliegen — arbeite mit dem Text allein.",
    );
  }
  lines.push("", "Aufgabe:");
  return lines.join("\n") + "\n";
}

async function skillPayload(home, name) {
  const config = await loadConfig(home).catch(() => ({ store: null }));
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") throw httpError(503, "No inventory — run `ninja init` first.");
    throw err;
  }
  const group = groupSkills(JSON.parse(raw).skills ?? []).find((g) => g.name === name);
  if (!group) throw httpError(404, `No skill named '${name}' in the inventory.`);

  const file = skillBodyFile(config, group);
  if (!file) throw httpError(404, `No readable SKILL.md for '${name}' (files vanished since init?).`);
  const text = await readFile(file, "utf8");
  const split = splitFrontmatter(text);
  const body = split ? split.body.join("\n") : text;
  const assets = await listAssets(join(file, ".."));
  return {
    raw: { name, text, assets },
    prompt: {
      name,
      text: buildChatPrompt({
        name,
        description: groupDescription(group.occurrences) ?? "",
        body,
        assets,
      }),
    },
  };
}

// --- engine + skills.sh execution ------------------------------------------------

function capture(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// Run the engine CLI as a child of this server — the one execution path, so
// the UI's writes are the CLI's writes (ADR-0019: thin adapter).
async function execEngine(home, { argv, cwd }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw httpError(400, "argv must be a non-empty array of strings.");
  }
  if (!EXEC_ALLOWED.has(argv[0])) {
    throw httpError(400, `Command '${argv[0]}' is not part of the Manager UI surface (${[...EXEC_ALLOWED].join(", ")}).`);
  }
  if (cwd !== undefined && cwd !== null) {
    if (typeof cwd !== "string" || !cwd.startsWith("/") || !existsSync(cwd)) {
      throw httpError(400, "cwd must be an absolute path to an existing directory.");
    }
  }
  const child = spawn(process.execPath, [ENGINE_PATH, ...argv], {
    env: { ...process.env, HOME: home },
    cwd: cwd || undefined,
  });
  const result = await capture(child, EXEC_TIMEOUT_MS);
  return { ...result, argv };
}

// External-skill removal, delegated to skills.sh (ADR-0020): Skill Ninja
// never deletes skills.sh-tracked files — `npx skills remove` keeps the
// lockfile consistent. Global scope removes from ~/, project scope runs in
// the given working directory.
async function removeExternal(home, { name, scope, projectDir }) {
  if (typeof name !== "string" || name === "") throw httpError(400, "name is required.");
  if (scope !== "global" && scope !== "project") {
    throw httpError(400, "scope must be 'global' or 'project'.");
  }
  if (scope === "project") {
    if (typeof projectDir !== "string" || !projectDir.startsWith("/") || !existsSync(projectDir)) {
      throw httpError(400, "project scope needs projectDir — an absolute path to an existing directory.");
    }
  }

  // Ownership check: only skills.sh-owned skills may be removed through this
  // endpoint (ADR-0020). Personal skills leave via `off`; plugin skills via
  // the agent's plugin manager (ADR-0018).
  const config = await loadConfig(home).catch(() => ({ store: null }));
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") throw httpError(503, "No inventory — run `ninja init` first.");
    throw err;
  }
  const group = groupSkills(JSON.parse(raw).skills ?? []).find((g) => g.name === name);
  if (!group) throw httpError(404, `No skill named '${name}' in the inventory.`);
  if (groupTier(group.occurrences, config.store) !== "External") {
    throw httpError(400, `'${name}' is not an External (skills.sh) skill — only those are removed by delegation (ADR-0020).`);
  }

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["-y", "skills", "remove", name, "-y"];
  if (scope === "global") args.push("-g");
  const child = spawn(command, args, {
    env: { ...process.env, HOME: home },
    cwd: scope === "project" ? projectDir : home,
  });
  const result = await capture(child, NPX_TIMEOUT_MS);
  return { ...result, command: `${command} ${args.join(" ")}` };
}

// --- server ---------------------------------------------------------------------

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw httpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be JSON.");
  }
}

// A skill name from a URL segment — one path segment, no traversal.
function safeName(segment) {
  const name = decodeURIComponent(segment);
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw httpError(400, "Invalid skill name.");
  }
  return name;
}

/**
 * The Manager UI server. Loopback-only by construction of `uiCommand`; the
 * handlers are pure with respect to `home`, so tests drive them against a
 * sandbox on an ephemeral port.
 * @param {{home?: string}} [options]
 * @returns {import("node:http").Server}
 */
export function createManagerServer({ home = homedir() } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, renderManagerPage(), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return send(res, 200, await buildState(home));
      }
      if (req.method === "POST" && url.pathname === "/api/exec") {
        return send(res, 200, await execEngine(home, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/note") {
        const { name, text } = await readJson(req);
        if (typeof name !== "string" || name === "") throw httpError(400, "name is required.");
        const { store } = await loadConfig(home);
        return send(res, 200, await saveNote(store, name, text));
      }
      if (req.method === "POST" && url.pathname === "/api/external-remove") {
        return send(res, 200, await removeExternal(home, await readJson(req)));
      }

      const skillMatch = url.pathname.match(/^\/api\/skill\/([^/]+)\/(raw|prompt)$/);
      if (req.method === "GET" && skillMatch) {
        const payload = await skillPayload(home, safeName(skillMatch[1]));
        return send(res, 200, payload[skillMatch[2]]);
      }

      return send(res, 404, { error: "Not found." });
    } catch (err) {
      const status = err?.status ?? 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: err?.message ?? "Internal error." });
    }
  });
}

// --- the `ui` command -------------------------------------------------------------

function parseUiArgs(argv) {
  const opts = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      const port = Number(v);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { error: `--port needs a number between 0 and 65535 (got '${v ?? ""}')` };
      }
      opts.port = port;
    } else if (a.startsWith("--port=")) {
      const port = Number(a.slice("--port=".length));
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { error: `--port needs a number between 0 and 65535 (got '${a.slice(7)}')` };
      }
      opts.port = port;
    } else if (a === "--no-open") {
      opts.open = false;
    } else {
      return { error: `unknown ui argument: ${a}` };
    }
  }
  return opts;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // best-effort — the URL is printed regardless
  child.unref();
}

/**
 * Run `ninja ui` — start the Manager UI server (ADR-0019). Foreground by
 * design: the returned promise never resolves, so the engine process stays
 * alive until interrupted. `--port 0` picks a free ephemeral port (tests).
 * @param {string[]} args
 */
export async function uiCommand(args) {
  const opts = parseUiArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nTry: ninja ui [--port <n>] [--no-open]\n`);
    return 2;
  }

  const home = homedir();
  const server = createManagerServer({ home });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port, "127.0.0.1", resolve);
    });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${opts.port} is busy — pass another one: ninja ui --port <n>\n`,
      );
      return 2;
    }
    throw err;
  }

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(
    `Skill Ninja Manager UI — ${url}\n` +
      `Local-only (loopback, no network). Reads the cached inventory; every write asks first. Ctrl-C stops it.\n`,
  );
  if (opts.open) openBrowser(url);

  // Run until interrupted — the server keeps the event loop alive.
  await new Promise(() => {});
}
