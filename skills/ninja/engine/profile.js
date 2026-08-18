// `ninja profile` — named, reusable skill sets applied per project (ADR-0014,
// CONTEXT.md "Profile"). Profiles live in the skill-ninja config
// (`profiles: { <name>: [<skill names>] }`); `apply` runs in the project's
// working directory and symlinks each member into `<cwd>/.agents/skills/` →
// `<store>/<name>` (project-local roots are discovered per workspace, so a
// globally-Off skill is active exactly where a project links it). Additive on
// the global Availability baseline; Personal members only (an External member
// is refused — its re-enabling per project would rest on undocumented
// ZCode override precedence). `lift` removes exactly the links the profile
// owns — never a real directory.

import { lstat, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cwd as processCwd } from "node:process";
import { loadConfig, readRawConfig, writeRawConfig } from "./config.js";
import { linkSkill } from "./links.js";

// The project-local skills root profiles link into — the cross-tool
// `.agents/skills` convention (ZCode workspace discovery level 5; the
// VetaSense pattern on this machine).
const PROJECT_ROOT_SEGMENTS = [".agents", "skills"];

function projectSkillsDir(projectDir) {
  return join(projectDir, ...PROJECT_ROOT_SEGMENTS);
}

async function loadProfiles(home) {
  const raw = await readRawConfig(home);
  const profiles = raw?.profiles && typeof raw.profiles === "object" ? raw.profiles : {};
  return { raw, profiles };
}

function listCommand(out, profiles, name) {
  const lines = ["Skill Ninja profiles"];
  if (name) {
    const members = profiles[name];
    if (!Array.isArray(members)) {
      out.write(`No profile '${name}'.\n`);
      return 2;
    }
    lines.push("", `'${name}' (${members.length} skill${members.length === 1 ? "" : "s"}):`);
    for (const m of members) lines.push(`  ${m}`);
    out.write(lines.join("\n") + "\n");
    return 0;
  }
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  lines.push("");
  if (names.length === 0) {
    lines.push("(no profiles saved)");
    lines.push("", "Save one with: ninja profile save <name> <skill> [<skill> …]");
  } else {
    for (const n of names) {
      const members = profiles[n];
      lines.push(`  ${n} (${members.length} skill${members.length === 1 ? "" : "s"})`);
    }
    lines.push("", "Show members with: ninja profile list <name>");
  }
  out.write(lines.join("\n") + "\n");
  return 0;
}

async function saveCommand(out, err, home, config, args) {
  const [name, ...skills] = args;
  if (!name || skills.length === 0) {
    err.write("save needs a profile name and at least one skill name.\n");
    err.write("Try: ninja profile save <name> <skill> [<skill> …]\n");
    return 2;
  }
  if (name.includes("/")) {
    err.write(`Invalid profile name: '${name}'\n`);
    return 2;
  }

  // Members must be stored Personal skills — the ones a project link can
  // point at (External installs belong to skills.sh, ADR-0007).
  const unknown = skills.filter((s) => !existsSync(join(config.store, s, "SKILL.md")));
  if (unknown.length) {
    err.write(
      `No stored skill ${unknown.map((s) => `'${s}'`).join(", ")} in the canonical store (${config.store}).\n` +
        "Profile members must be stored skills — run `ninja add` first.\n",
    );
    return 2;
  }

  const { raw, profiles } = await loadProfiles(home);
  const members = [...new Set(skills)];
  const existed = Array.isArray(profiles[name]);
  profiles[name] = members;
  raw.profiles = profiles;
  await writeRawConfig(home, raw);
  out.write(
    `${existed ? "Updated" : "Saved"} profile '${name}' with ${members.length} skill${members.length === 1 ? "" : "s"}.\n` +
      `Apply it in a project with: ninja profile apply ${name}\n`,
  );
  return 0;
}

async function forgetCommand(out, err, home, args) {
  const [name] = args;
  if (!name) {
    err.write("forget needs a profile name.\n");
    err.write("Try: ninja profile forget <name>\n");
    return 2;
  }
  const { raw, profiles } = await loadProfiles(home);
  if (!Array.isArray(profiles[name])) {
    err.write(`No profile '${name}'.\n`);
    return 2;
  }
  delete profiles[name];
  raw.profiles = profiles;
  await writeRawConfig(home, raw);
  out.write(`Forgot profile '${name}'. (Links already applied in projects stay until lifted.)\n`);
  return 0;
}

async function applyCommand(out, err, home, config, args) {
  const [name] = args;
  if (!name) {
    err.write("apply needs a profile name.\n");
    err.write("Try: ninja profile apply <name>\n");
    return 2;
  }
  const { profiles } = await loadProfiles(home);
  const members = profiles[name];
  if (!Array.isArray(members)) {
    err.write(`No profile '${name}'. Save it with: ninja profile save ${name} <skill> …\n`);
    return 2;
  }

  const projectDir = processCwd();
  const linkDir = projectSkillsDir(projectDir);
  const linked = [];
  const skipped = [];
  for (const m of members) {
    const linkPath = join(linkDir, m);
    // Never replace a real directory — that is content, not a link (the same
    // guard the availability link ops use).
    try {
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) {
        skipped.push(`${m} — a real directory exists at ${linkPath}`);
        continue;
      }
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
    }
    await linkSkill(linkPath, join(config.store, m));
    linked.push(m);
  }

  out.write(`Applied profile '${name}' in ${projectDir}.\n`);
  out.write(
    `${linked.length} link${linked.length === 1 ? "" : "s"} at ${linkDir} -> ${config.store}.\n`,
  );
  for (const s of skipped) out.write(`  - skipped ${s}\n`);
  out.write(
    "Additive on the global baseline — run `ninja status` after `ninja init` to see them. " +
      "Takes effect in NEW agent sessions.\n",
  );
  return 0;
}

async function liftCommand(out, err, home, config, args) {
  const [name] = args;
  if (!name) {
    err.write("lift needs a profile name.\n");
    err.write("Try: ninja profile lift <name>\n");
    return 2;
  }
  const { profiles } = await loadProfiles(home);
  const members = profiles[name];
  if (!Array.isArray(members)) {
    err.write(`No profile '${name}'.\n`);
    return 2;
  }

  const projectDir = processCwd();
  const linkDir = projectSkillsDir(projectDir);
  const lifted = [];
  const skipped = [];
  // The canonical store path — the config may name it through a symlink
  // (e.g. /tmp vs /private/tmp) while realpath resolves through it.
  const storeReal = await realpath(config.store).catch(() => config.store);
  for (const m of members) {
    const linkPath = join(linkDir, m);
    let resolved;
    try {
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) {
        skipped.push(`${m} — not a link at ${linkPath}`);
        continue;
      }
      resolved = await realpath(linkPath);
    } catch (e) {
      if (e && e.code === "ENOENT") {
        continue; // nothing there — already lifted
      }
      throw e;
    }
    // Only remove links that point into the store (ours).
    const prefix = storeReal.endsWith("/") ? storeReal : storeReal + "/";
    if (resolved !== storeReal && !resolved.startsWith(prefix)) {
      skipped.push(`${m} — points outside the store (${resolved})`);
      continue;
    }
    await rm(linkPath, { recursive: true, force: true });
    lifted.push(m);
  }

  out.write(`Lifted profile '${name}' in ${projectDir}: ${lifted.length} link${lifted.length === 1 ? "" : "s"} removed.\n`);
  for (const s of skipped) out.write(`  - skipped ${s}\n`);
  return 0;
}

/**
 * Run `ninja profile`. Returns the process exit code.
 * @param {string[]} args
 */
export async function profileCommand(args) {
  const out = process.stdout;
  const err = process.stderr;
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "list") {
    const home = homedir();
    const { profiles } = await loadProfiles(home);
    return listCommand(out, profiles, rest[0]);
  }

  const home = homedir();
  let config;
  try {
    config = await loadConfig(home);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      err.write("No Skill Ninja configuration found. Run `ninja init` first.\n");
      return 2;
    }
    throw e;
  }
  if (!config.store) {
    err.write("No canonical store configured (set `store` in ~/.skill-ninja/config.json).\n");
    return 2;
  }

  if (sub === "save") return saveCommand(out, err, home, config, rest);
  if (sub === "forget") return forgetCommand(out, err, home, rest);
  if (sub === "apply") return applyCommand(out, err, home, config, rest);
  if (sub === "lift") return liftCommand(out, err, home, config, rest);

  err.write(`Unknown profile subcommand: ${sub}\n`);
  err.write("Try: ninja profile list [name] | save <name> <skill> … | forget <name> | apply <name> | lift <name>\n");
  return 2;
}
