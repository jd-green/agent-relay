import { fail } from "./errors";

interface SecretPattern {
  kind: string;
  pattern: RegExp;
  /** For formats with a free-form body: the whole match must also look generated, not like a name. */
  generated?: (match: string) => boolean;
}

const hasDigit = (text: string) => /[0-9]/.test(text);
const hasUpper = (text: string) => /[A-Z]/.test(text);

// Lookbehinds keep prefixes inside ordinary words (e.g. "task-…" containing "sk-") from matching.
// Provider patterns come before the generic sk- pattern so they are reported by their own name.
// There is no exemption of any kind (1Password references included): every pattern runs on the raw
// text. Where a key format has a free-form body, the body must also look generated (a digit, an
// uppercase letter, or a hex run), so identifiers and 1Password item or field names such as
// "sk-ant-production-api-key", "xoxb-deploy-bot-token" or "rk_live_restricted" never match.
// Bodies are matched greedily and `generated` checks the whole match, which keeps a scan linear
// even when one run holds many prefixes ("sk-ant-sk-ant-…").
const PATTERNS: readonly SecretPattern[] = [
  {
    kind: "Anthropic API key",
    pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g,
    generated: (match) => hasDigit(match) && hasUpper(match),
  },
  { kind: "OpenRouter API key", pattern: /(?<![A-Za-z0-9])sk-or-v1-[0-9a-f]{32,}/g },
  // A known OpenAI prefix, a lowercase hex body (DeepSeek-style keys), or a body with at least one
  // digit and one uppercase letter, so that all-lowercase kebab-case identifiers
  // ("sk-loading-skeleton-…", "sk-learn-model-selection-guide") never match.
  {
    kind: "OpenAI-style API key",
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{32,}|[0-9a-f]{32,}(?![A-Za-z0-9_-])|(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,})/g,
  },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g },
  {
    kind: "GitHub token",
    pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
    generated: (match) => hasDigit(match) && hasUpper(match),
  },
  { kind: "AWS access key id", pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
  { kind: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, generated: hasDigit },
  { kind: "Google API key", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  {
    kind: "Stripe live key",
    pattern: /(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{10,}/g,
    generated: (match) => hasDigit(match) || hasUpper(match),
  },
  { kind: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

export interface SecretHit {
  kind: string;
  path: string;
}

function scanText(text: string, tokens: readonly string[]): string | null {
  if (tokens.some((token) => text.includes(token))) return "relay role token";
  for (const { kind, pattern, generated } of PATTERNS) {
    for (const [match] of text.matchAll(pattern)) {
      if (!generated || generated(match)) return kind;
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
