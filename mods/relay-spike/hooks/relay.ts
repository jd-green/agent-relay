import type { HttpInit, HttpResponse, PluginOptions } from 'claude-code'

/**
 * How long one relay request may take before it counts as unreachable. `$.http.fetch` cannot be
 * aborted, so a request given up on still holds the process until the engine's own timeout ends it.
 */
export const REQUEST_TIMEOUT_MS = 3_000

/** Hosts a plain `http://` relay_url may name: the role token never leaves the machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

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

/** How long a request may take, and who hears its answer when it comes after that. */
export type RequestOptions = {
  timeoutMs?: number
  /** Called with the answer of a request that came back after its timeout (a read that marked mail read). */
  onLate?: (reply: RelayReply) => void
}

/**
 * Reads the userConfig values every relay Mod shares. Throws the reason an
 * unusable value fails the load with, which the person sees.
 */
export function readConfig(plugin: string, options: PluginOptions, defaultPollSeconds: number): RelayConfig {
  const url = String(options.relay_url ?? '').trim().replace(/\/+$/, '')
  const token = String(options.role_token ?? '').trim()
  if (!URL.canParse(url) || !/^https?:/.test(url)) throw new Error(`${plugin}: relay_url must be an https URL`)
  const { protocol, hostname } = new URL(url)
  // The token rides every request's Authorization header: in clear text only to this machine.
  if (protocol === 'http:' && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${plugin}: relay_url must be https (http:// is accepted only for localhost and 127.0.0.1)`)
  }
  if (token === '') throw new Error(`${plugin}: role_token must be set`)
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
  options: RequestOptions = {},
): Promise<RelayReply> {
  const timeoutMs = Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS)
  const headers: Record<string, string> = { authorization: `Bearer ${config.token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const answer = (async (): Promise<RelayReply> => {
    try {
      const response = await host.fetch(config.url + path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      return toReply(response)
    } catch (error) {
      return { ok: false, status: 0, code: 'unreachable', message: errorText(error) }
    }
  })()
  const reply = await withTimeout(host, answer, Math.max(0, timeoutMs))
  if (reply !== undefined) return reply
  const { onLate } = options
  if (onLate !== undefined) void answer.then(onLate)
  return { ok: false, status: 0, code: 'timeout', message: `no answer within ${formatSeconds(timeoutMs)}` }
}

function toReply(response: HttpResponse): RelayReply {
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

/** `3s`, `1.5s`. */
const formatSeconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`

/** A short, single-line description of a thrown value. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 300)
}

/** The first `chars` hex digits of the SHA-256 of `text`: lets two values be compared without sending either. */
export async function sha256Prefix(text: string, chars = 16): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars)
}
