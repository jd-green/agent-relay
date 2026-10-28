import type { HttpInit, HttpResponse, PluginOptions } from 'claude-code'

/** How long one relay request may take before it counts as unreachable. */
export const REQUEST_TIMEOUT_MS = 8_000

/**
 * The engine calls the relay client needs, as closures over a hook's `$`
 * (a hooks module spells every call `$.noun.method(...)` where it is made).
 */
export type Host = {
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>
  now: () => Promise<number>
}

export type RelayConfig = { url: string; token: string; pollMs: number }

/** One relay answer, unwrapped from the `{ok, result}` / `{ok: false, error}` envelope. */
export type RelayReply =
  | { ok: true; status: number; result: unknown }
  | { ok: false; status: number; code: string; message: string }

/** Reads the userConfig values every relay Mod shares; `undefined` when they are unusable. */
export function readConfig(options: PluginOptions, defaultPollSeconds: number): RelayConfig | undefined {
  const url = String(options.relay_url ?? '').trim().replace(/\/+$/, '')
  const token = String(options.role_token ?? '').trim()
  if (!URL.canParse(url) || !/^https?:/.test(url) || token === '') return undefined
  const seconds = Number(options.poll_seconds)
  const pollSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : defaultPollSeconds
  return { url, token, pollMs: Math.max(15, pollSeconds) * 1000 }
}

/** Resolves `work`, or `undefined` once `ms` have passed on the engine's clock. */
export async function withTimeout<T>(host: Host, work: Promise<T>, ms: number): Promise<T | undefined> {
  const timer = new AbortController()
  const timeout = host.sleep(ms, { signal: timer.signal }).then(
    () => undefined,
    () => undefined,
  )
  try {
    return await Promise.race([work, timeout])
  } finally {
    timer.abort()
  }
}

/** Calls the relay with the role's bearer token. Never throws: failures come back as `ok: false`. */
export async function relayRequest(
  host: Host,
  config: RelayConfig,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<RelayReply> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  try {
    const response = await withTimeout(
      host,
      host.fetch(config.url + path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      REQUEST_TIMEOUT_MS,
    )
    if (response === undefined) {
      return { ok: false, status: 0, code: 'timeout', message: `no answer within ${REQUEST_TIMEOUT_MS / 1000}s` }
    }
    const envelope = parseEnvelope(response.text)
    if (envelope === undefined) {
      return { ok: false, status: response.status, code: `http_${response.status}`, message: 'the answer was not a relay envelope' }
    }
    if (response.ok && envelope.ok === true) return { ok: true, status: response.status, result: envelope.result }
    return {
      ok: false,
      status: response.status,
      code: typeof envelope.error?.code === 'string' ? envelope.error.code : `http_${response.status}`,
      message: typeof envelope.error?.message === 'string' ? envelope.error.message : `HTTP ${response.status}`,
    }
  } catch (error) {
    return { ok: false, status: 0, code: 'unreachable', message: errorText(error) }
  }
}

type Envelope = { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }

function parseEnvelope(text: string): Envelope | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Envelope) : undefined
  } catch {
    return undefined
  }
}

/** A short, single-line description of a thrown value. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 300)
}
