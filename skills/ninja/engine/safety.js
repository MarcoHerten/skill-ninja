// The lightweight safety check (SPEC.md, "Safety check"; Issue #3).
//
// Static pattern matching over an incoming Skill's content (SKILL.md + any
// bundled scripts), NOT a sandbox. It reports risky patterns in plain language
// so the skill layer can gate approval; the engine never blocks an install on a
// finding. The pattern set is data — a documented, extensible list — so T6
// (`doctor`) can reuse the same scanner.
//
// Categories:
//   destructive — unbounded / destructive shell (rm -rf, sudo, chmod 777, dd, mkfs, fork bombs).
//   network     — outbound network calls (curl, wget, fetch, http(s)://, ssh, scp, nc, raw IPs).
//   hidden      — obfuscated / hidden commands (eval, backticks, $(...), base64 decode, /dev redirects, secret env refs).
//
// This is honest about its limits: it is substring/regex matching, easily
// evaded or falsely tripped. Trust ultimately comes from Provenance + human
// review, not from this check.

// Each pattern: an id, a regex, a severity, a category, and a plain-language
// message (templated with {match} for the matched token). Regexes use word
// boundaries for command names to cut obvious false positives in prose.
const PATTERNS = [
  // --- destructive (high) ---
  { id: "rm-rf", re: /\brm\s+-rf\b/, severity: "high", category: "destructive",
    message: "Destructive shell command: `{match}` deletes files recursively and cannot be undone." },
  { id: "sudo", re: /\bsudo\b/, severity: "high", category: "destructive",
    message: "Privilege escalation: `{match}` runs commands as root." },
  { id: "chmod-777", re: /\bchmod\s+(-R\s+)?777\b/, severity: "high", category: "destructive",
    message: "Over-permissive mode: `{match}` opens files to everyone." },
  { id: "dd-of", re: /\bdd\b[^|]*\bof=/, severity: "high", category: "destructive",
    message: "Raw disk write: `{match}` can overwrite a device or file at low level." },
  { id: "mkfs", re: /\bmkfs\b/, severity: "high", category: "destructive",
    message: "Filesystem format: `{match}` can wipe a whole filesystem." },
  { id: "fork-bomb", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, severity: "high", category: "destructive",
    message: "Fork bomb: `{match}` can exhaust process resources." },

  // --- network (medium) ---
  { id: "curl", re: /\bcurl\b/, severity: "medium", category: "network",
    message: "Network call: `{match}` fetches from or posts to the network." },
  { id: "wget", re: /\bwget\b/, severity: "medium", category: "network",
    message: "Network call: `{match}` downloads from the network." },
  { id: "fetch", re: /\bfetch\s*\(/, severity: "medium", category: "network",
    message: "Network call: `{match}` issues a programmatic HTTP request." },
  { id: "ssh", re: /\bssh\b/, severity: "medium", category: "network",
    message: "Remote shell: `{match}` opens a connection to another machine." },
  { id: "scp", re: /\bscp\b/, severity: "medium", category: "network",
    message: "Remote copy: `{match}` transfers files to another machine." },
  { id: "nc", re: /\bnc\s+/, severity: "medium", category: "network",
    message: "Netcat: `{match}` can open arbitrary network connections." },
  { id: "http-url", re: /\bhttps?:\/\//i, severity: "medium", category: "network",
    message: "Network address: `{match}` is a URL the skill may contact." },
  { id: "raw-ip", re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, severity: "medium", category: "network",
    message: "Network address: `{match}` is a raw IP the skill may contact." },

  // --- hidden / obfuscated (medium) ---
  { id: "eval", re: /\beval\b/, severity: "medium", category: "hidden",
    message: "Dynamic execution: `{match}` runs a string as code, hiding its intent." },
  { id: "base64-decode", re: /\bbase64\b[^|]*\b(--decode|-d)\b/, severity: "medium", category: "hidden",
    message: "Decoded payload: `{match}` decodes a base64 blob, a common obfuscation." },
  { id: "cmd-substitution", re: /\$\([^)]*\)/, severity: "medium", category: "hidden",
    message: "Command substitution: `{match}` runs a hidden subcommand inline." },
  { id: "backticks", re: /`[^`]+`/, severity: "medium", category: "hidden",
    message: "Hidden command: `{match}` uses backticks to run a subcommand." },
  { id: "dev-redirect", re: />\s*\/dev\//, severity: "medium", category: "hidden",
    message: "Redirect to a device: `{match}` may write to a device file." },
  { id: "secret-env", re: /\$(AWS_|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|HOME\/\.ssh)/, severity: "medium", category: "hidden",
    message: "Secret reference: `{match}` reads a credential or private key path." },
];

// Deduplicate findings by (id, file, line) so the same pattern on one line
// reports once even if matched by overlapping regexes.
function sameSpot(a, b) {
  return a.id === b.id && a.file === b.file && a.line === b.line;
}

/**
 * Scan one file's content for risky patterns.
 * @param {string} content
 * @param {string} file Display name (relative label) of the file.
 * @returns {Array<{id,severity,category,message,snippet,file,line}>}
 */
export function scanContent(content, file) {
  const findings = [];
  if (typeof content !== "string") return findings;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      const finding = {
        id: p.id,
        severity: p.severity,
        category: p.category,
        message: p.message.replace("{match}", m[0]),
        snippet: line.trim().slice(0, 160),
        file,
        line: i + 1,
      };
      if (!findings.some((f) => sameSpot(f, finding))) findings.push(finding);
    }
  }
  return findings;
}

/**
 * Scan a set of files (an incoming skill: SKILL.md + bundled scripts).
 * @param {Array<{path:string, content:string}>} files
 * @returns {Array} findings (see scanContent), across all files.
 */
export function scanSafety(files) {
  const all = [];
  for (const f of files ?? []) {
    const label = f.relPath || f.path || "SKILL.md";
    all.push(...scanContent(f.content, label));
  }
  return all;
}

/**
 * Render findings as a plain-language report (with a summary line). The engine
 * prints this to stdout before placing a skill.
 * @param {Array} findings
 * @returns {string}
 */
export function renderSafety(findings) {
  if (!findings || findings.length === 0) {
    return "Safety check: no findings.\n";
  }
  const lines = ["Safety check:"];
  for (const f of findings) {
    const sev = f.severity.toUpperCase();
    lines.push(`  [${sev}] ${f.message}`);
    lines.push(`    file: ${f.file}`);
    lines.push(`    > ${f.snippet}`);
  }
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  const bits = [];
  if (high) bits.push(`${high} high`);
  if (medium) bits.push(`${medium} medium`);
  const word = findings.length === 1 ? "finding" : "findings";
  lines.push(`${findings.length} safety ${word}: ${bits.join(", ")}.`);
  return lines.join("\n") + "\n";
}
