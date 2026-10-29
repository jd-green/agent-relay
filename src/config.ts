export interface Config {
  humanName: string;
  nudgeAfterMs: number;
  maxMessagesPerBuild: number;
  maxReviewRounds: number;
  burstPerMinute: number;
  maxActiveBuilds: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = positiveNumber(raw, fallback);
  return Number.isInteger(value) ? value : fallback;
}

/** Reads the wrangler vars (all strings); invalid or missing values fall back to the defaults. */
export function loadConfig(env: Env): Config {
  return {
    humanName: env.HUMAN_NAME?.trim() || "James",
    nudgeAfterMs: positiveNumber(env.NUDGE_AFTER_MINUTES, 30) * 60_000,
    maxMessagesPerBuild: positiveInteger(env.MAX_MESSAGES_PER_BUILD, 200),
    maxReviewRounds: positiveInteger(env.MAX_REVIEW_ROUNDS, 3),
    burstPerMinute: positiveInteger(env.BURST_PER_MINUTE, 10),
    maxActiveBuilds: positiveInteger(env.MAX_ACTIVE_BUILDS, 1),
  };
}
