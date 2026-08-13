// Shared linking helper — the pattern `add` introduced and `doctor` reuses for
// dedup consolidation. Resolves **tool asymmetry** the Skill Ninja way: ONE
// canonical copy under the **canonical store**, symlinked into every **agent
// root** (or other location) that should see it. (CONTEXT.md: Tool asymmetry;
// SPEC.md: "no multi-target deploy"; ADR-0006.)
//
// Extracted so `add` and `doctor` link identically rather than each open-coding
// the rm-then-symlink sequence.

import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Create (or refresh) a symlink at `linkPath` that points at `targetDir`. Any
 * existing file, directory, or symlink at `linkPath` is removed first; the parent
 * directory is created if missing. The result is `<linkPath> -> <targetDir>`.
 *
 * @param {string} linkPath Where the symlink lives (e.g. `<agent-root>/<name>`).
 * @param {string} targetDir The canonical directory it points at (`<store>/<name>`).
 */
export async function linkSkill(linkPath, targetDir) {
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  await symlink(targetDir, linkPath, "dir");
}
