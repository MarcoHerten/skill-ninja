// Shared git machinery for the canonical store (ADR-0007): the store is a git
// repo with an optional private remote. `add` commits each skill and pushes;
// `ingest --apply` commits the whole approved batch as one commit and pushes.
// Every helper is best-effort — git unavailable, nothing to commit, or a hook
// rejection downgrades to "no versioning", never a failed command.

import { execFileSync } from "node:child_process";

function isGitRepo(dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The first configured remote name (typically "origin"), or null if none.
function firstRemote(store) {
  try {
    const out = execFileSync("git", ["-C", store, "remote"], { encoding: "utf8" });
    const name = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return name || null;
  } catch {
    return null;
  }
}

// Stage the given pathspecs (an array of names/paths) and commit them with the
// message. One atomic commit; the caller picks the unit (`add`: one skill,
// `ingest`: the batch). Returns false when the store is not a repo or the
// commit is empty/rejected.
function tryCommit(store, pathspecs, message) {
  if (!isGitRepo(store)) return false;
  try {
    execFileSync("git", ["-C", store, "add", "--", ...pathspecs], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", store, "-c", "user.name=Skill Ninja", "-c", "user.email=skill-ninja@local", "commit", "-q", "-m", message],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false; // nothing to commit, or a hook rejected it — skip silently
  }
}

// Push the just-committed work to the private remote. Sets upstream on the
// first push so a freshly-init'd store pushes without extra setup. Skipped
// silently (returns false) when no remote is configured or the push fails.
function tryPush(store) {
  const remote = firstRemote(store);
  if (!remote) return false;
  try {
    execFileSync("git", ["-C", store, "push", "-q", "-u", remote, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export { isGitRepo, firstRemote, tryCommit, tryPush };
