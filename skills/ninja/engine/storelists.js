// Store-side name lists (ADR-0017): collections and profiles live as JSON
// files at the canonical store's root — <store>/collections.json and
// <store>/profiles.json — so they travel with the store repo: clone it on a
// fresh machine, run `init`, and the bundles are back. This module is the one
// read/write/commit seam both features share; commits ride the same
// best-effort git machinery as every other store write (cat assign's pattern).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { normalizeNameLists } from "./config.js";
import { tryCommit, tryPush } from "./git.js";

export const COLLECTIONS_FILE = "collections.json";
export const PROFILES_FILE = "profiles.json";

/**
 * Read a store-side name list. A missing file (fresh machine, nothing saved
 * yet) or a malformed one is an empty map — the lists are personal filters,
 * never load-bearing state a view should die on. Members are normalized by
 * the same rule the config lists used (one rule, new home).
 * @param {string|null} store Absolute store path (null ⇒ {}).
 * @param {string} file The list file name.
 * @returns {Promise<object>} The normalized name → string[] map.
 */
export async function readStoreList(store, file) {
  if (!store) return {};
  let raw;
  try {
    raw = await readFile(join(store, file), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeNameLists(parsed);
  } catch {
    return {};
  }
}

/**
 * Write a store-side name list (2-space JSON + trailing newline — the format
 * every Skill Ninja artifact writes). Creates the store directory if needed.
 * @param {string} store Absolute store path.
 * @param {string} file The list file name.
 * @param {object} map The name → string[] map.
 */
export async function writeStoreList(store, file, map) {
  await mkdir(store, { recursive: true });
  await writeFile(join(store, file), JSON.stringify(map, null, 2) + "\n", "utf8");
}

/**
 * Commit one list file and push when a remote is configured (best-effort —
 * a store without git simply stays uncommitted, like every store write).
 * @returns {boolean} Whether a commit landed.
 */
export function commitStoreList(store, file, message) {
  const committed = tryCommit(store, [file], message);
  if (committed) tryPush(store);
  return committed;
}
