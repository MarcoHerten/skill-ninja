// Shared Skill-source resolution. `add` and `diff` both turn a source argument
// (a folder, a bare SKILL.md file, or a repo/URL) into the skill's SKILL.md
// content plus the directory it came from. Keeping this in one place means
// "diff against an upstream/external version" reuses literally the same clone
// path `add` uses — there is one resolver, not two. (Issues #3 / #5.)
//
// Engine-internal module (not part of the ADR-0001 test seam): tests exercise it
// only through the CLI.

import { execFileSync } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A source is a repo/URL when it looks remote (URL schemes, git@, owner/repo
// shorthand) or ends in `.git`. owner/repo only counts when it is not an
// existing local path (so a relative folder is never mistaken for a GitHub repo).
export function looksLikeRepo(source) {
  if (typeof source !== "string") return false;
  if (source.endsWith(".git")) return true;
  if (/^(https?|ssh|git):\/\//.test(source)) return true;
  if (/^git@/.test(source)) return true;
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source) && !existsSync(source)) return true;
  return false;
}

// Clone a repo/URL source into a fresh temp dir and return that dir. The owner/
// repo shorthand is expanded to a GitHub https URL. Throws a plain-language
// error on failure (the skill layer frames it for the user).
export function cloneRepo(source) {
  const url =
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source) && !existsSync(source)
      ? `https://github.com/${source}`
      : source;
  const tmp = mkdtempSync(join(tmpdir(), "skill-ninja-clone-"));
  try {
    execFileSync("git", ["clone", "--quiet", url, tmp], { stdio: "pipe" });
  } catch {
    throw new Error(`failed to clone '${source}'`);
  }
  return tmp;
}

// stat that resolves to null for a missing path instead of throwing.
export async function statOrNull(p) {
  try {
    return await stat(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Resolve a folder / bare-file / repo-URL source into its SKILL.md content, the
 * working directory it came from (null for a bare file), and a sourceType tag.
 * Throws a plain-language error when the source is unusable (not found, or a
 * folder/repo with no SKILL.md). Shared by `add` and `diff` so the two commands
 * resolve sources identically.
 *
 * @param {string} source A folder, a bare SKILL.md file path, or a repo/URL.
 * @returns {Promise<{content: string, dir: string|null, sourceType: "folder"|"file"|"repo"}>}
 */
export async function resolveSkillFromSource(source) {
  let sourceType;
  let dir = null;
  let content;
  if (looksLikeRepo(source)) {
    sourceType = "repo";
    dir = cloneRepo(source);
  } else {
    const st = await statOrNull(source);
    if (st && st.isDirectory()) {
      sourceType = "folder";
      dir = source;
    } else if (st && st.isFile()) {
      sourceType = "file";
      content = await readFile(source, "utf8");
    } else {
      throw new Error(`source not found: ${source}`);
    }
  }
  if (dir) {
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) throw new Error(`no SKILL.md found in ${dir}`);
    content = await readFile(skillFile, "utf8");
  }
  return { content, dir, sourceType };
}
