import { fail } from "./errors";

interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

// Lookbehinds keep prefixes inside ordinary words (e.g. "task-…" containing "sk-") from matching.
// The Anthropic pattern comes before the generic sk- pattern so it is reported by its own name.
// Every pattern is global: the scanner looks at each match, not just the first.
const PATTERNS: readonly SecretPattern[] = [
  { kind: "Anthropic API key", pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g },
  // A known OpenAI prefix, or a body with at least one digit and one uppercase letter, so that
  // all-lowercase kebab-case identifiers ("sk-loading-skeleton-…") never match.
  {
    kind: "OpenAI-style API key",
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-(?=[A-Za-z0-9_-]*[0-9A-Z])|(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z]))[A-Za-z0-9_-]{32,}/g,
  },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "AWS access key id", pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
  { kind: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Google API key", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  { kind: "Stripe live key", pattern: /(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{10,}/g },
  { kind: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

// 1Password references name a secret without containing it, so a match wholly inside one is allowed.
// Only the strict form counts: op://<vault>/<item>/<field>[/<section>]. Vault and item names may hold
// spaces; the last segment may not, so a reference can't swallow the text that follows it.
const OP_REFERENCE = /op:\/\/[A-Za-z0-9 ._-]+\/[A-Za-z0-9 ._-]+\/(?:[A-Za-z0-9 ._-]+\/)?[A-Za-z0-9._-]+\b/g;

export interface SecretHit {
  kind: string;
  path: string;
}

function scanText(text: string, tokens: readonly string[]): string | null {
  // Role tokens are checked on the raw text: they never belong in a reference.
  if (tokens.some((token) => text.includes(token))) return "relay role token";
  const references = [...text.matchAll(OP_REFERENCE)].map((match) => ({ from: match.index, to: match.index + match[0].length }));
  const inReference = (start: number, end: number) => references.some(({ from, to }) => start >= from && end <= to);
  for (const { kind, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!inReference(match.index, match.index + match[0].length)) return kind;
    }
  }
  return null;
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
