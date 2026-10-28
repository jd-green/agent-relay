import { fail } from "./errors";

interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

// Lookbehinds keep prefixes inside ordinary words (e.g. "task-…" containing "sk-") from matching.
// The Anthropic pattern comes before the generic sk- pattern so it is reported by its own name.
const PATTERNS: readonly SecretPattern[] = [
  { kind: "Anthropic API key", pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/ },
  { kind: "OpenAI-style API key", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/ },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "AWS access key id", pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/ },
  { kind: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/ },
  { kind: "Stripe live key", pattern: /(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{10,}/ },
  { kind: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

// 1Password references name a secret without containing it, so they are allowed.
const OP_REFERENCE = /op:\/\/[^\s"'<>`)\]]+/g;

export interface SecretHit {
  kind: string;
  path: string;
}

function scanText(text: string, tokens: readonly string[]): string | null {
  const cleaned = text.replace(OP_REFERENCE, " ");
  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(cleaned)) return kind;
  }
  return tokens.some((token) => cleaned.includes(token)) ? "relay role token" : null;
}

/** Walks every string in value (depth first) and returns the first secret-looking one. */
export function findSecret(value: unknown, tokens: readonly string[], path = ""): SecretHit | null {
  if (typeof value === "string") {
    const kind = scanText(value, tokens);
    return kind ? { kind, path: path || "input" } : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findSecret(item, tokens, `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const hit = findSecret(item, tokens, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

export function assertNoSecrets(value: unknown, tokens: readonly string[]): void {
  const hit = findSecret(value, tokens);
  if (hit) {
    fail(
      "secret_detected",
      `${hit.path} looks like it contains a secret (${hit.kind}). Remove it and reference secrets by op:// path instead.`,
    );
  }
}
