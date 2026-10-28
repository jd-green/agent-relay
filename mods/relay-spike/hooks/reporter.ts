import type { JsonValue, PromptSubmitResult } from 'claude-code'

import { type Host, type RelayConfig, type RelayReply, errorText, relayRequest } from './relay'

/** What the spike needs from the engine beyond the relay client's calls. */
export type SpikeHost = Host & {
  sessionId: () => Promise<string>
  surfaces: () => Promise<readonly string[]>
  submit: (text: string) => Promise<PromptSubmitResult>
}

/** Small metadata attached to an event: lengths, names, kinds. Never prompt text or file contents. */
export type Detail = Record<string, JsonValue>

type SpikeRecord = {
  event: string
  ts: string
  session_id?: string
  surface?: string
  agent_id?: string
  detail?: Detail
}

/** Records kept while the relay cannot be reached; the oldest go first past this. */
const MAX_QUEUE = 500
/**
 * Individual records per event name per load; later occurrences are only counted (see the heartbeat).
 * Heartbeats and wake records are exempt: they are what an overnight run is read by.
 */
const MAX_RECORDS_PER_EVENT = 50
/** POSTs per flush, so one flush never floods the relay. */
const POSTS_PER_FLUSH = 20
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000

/**
 * Buffers spike events and posts them to `POST /spike/events` in small batches.
 * `record` is synchronous and never throws, so hooks call it and move on; the
 * network work happens in `flush`, driven by the mod's timer.
 */
export class Reporter {
  readonly startedAt = Date.now()
  sessionId: string | undefined
  surface = 'none'
  sent = 0
  dropped = 0
  rejected = 0
  tokenState: 'unknown' | 'accepted' | 'rejected' = 'unknown'
  lastError: { at: number; text: string } | undefined
  lastSentAt: number | undefined

  private readonly config: RelayConfig
  private readonly queue: SpikeRecord[] = []
  private readonly seen = new Map<string, number>()
  private failures = 0
  private retryAt = 0
  private isFlushing = false
  private hasLastCallFailed = false

  constructor(config: RelayConfig) {
    this.config = config
  }

  /** Counts one occurrence of `event` and queues a record of it, within the per-event cap unless `uncapped`. */
  record(event: string, detail?: Detail, agentId?: string, options: { uncapped?: boolean } = {}): void {
    const count = (this.seen.get(event) ?? 0) + 1
    this.seen.set(event, count)
    if (count > MAX_RECORDS_PER_EVENT && options.uncapped !== true) return
    this.queue.push({
      event,
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      surface: this.surface,
      agent_id: agentId,
      detail,
    })
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift()
      this.dropped += 1
    }
  }

  /** Re-reads the session id and surfaces, which change on /clear and as clients attach. */
  async refresh(host: SpikeHost): Promise<void> {
    try {
      this.sessionId = await host.sessionId()
      const surfaces = await host.surfaces()
      this.surface = surfaces.length > 0 ? surfaces.join(',') : 'none'
    } catch (error) {
      this.noteError('session info', errorText(error))
    }
  }

  /** Calls the relay and keeps the token state and last error up to date. */
  async call(host: Host, path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<RelayReply> {
    const reply = await relayRequest(host, this.config, path, init)
    // A record the relay refused for itself says nothing about whether the relay answers.
    this.hasLastCallFailed = !reply.ok && !isPermanent(reply.status)
    if (reply.ok) this.tokenState = 'accepted'
    else {
      if (reply.status === 401) this.tokenState = 'rejected'
      this.noteError(`${init?.method ?? 'GET'} ${path.split('?')[0]}`, `${reply.code}: ${reply.message}`)
    }
    return reply
  }

  /** Posts queued records, backing off after a failure. One flush at a time. */
  async flush(host: Host): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return
    if ((await host.now()) < this.retryAt) return
    this.isFlushing = true
    try {
      for (let posted = 0; posted < POSTS_PER_FLUSH && this.queue.length > 0; posted += 1) {
        const reply = await this.call(host, '/spike/events', { method: 'POST', body: this.queue[0] })
        if (reply.ok) {
          this.queue.shift()
          this.sent += 1
          this.failures = 0
          this.lastSentAt = Date.now()
        } else if (isPermanent(reply.status)) {
          // The relay refused this record itself (it fails validation): drop it, keep the rest.
          this.queue.shift()
          this.rejected += 1
        } else {
          this.failures += 1
          this.retryAt = (await host.now()) + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.failures)
          return
        }
      }
    } finally {
      this.isFlushing = false
    }
  }

  noteError(where: string, text: string): void {
    this.lastError = { at: Date.now(), text: `${where}: ${text}` }
  }

  /** Occurrences per event name since the mod loaded, most frequent first. */
  counts(): [string, number][] {
    return [...this.seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }

  get queued(): number {
    return this.queue.length
  }

  /** The last request failed or timed out: at exit, a flush would only start one more that hangs the process. */
  get isFailing(): boolean {
    return this.hasLastCallFailed
  }
}

/** 4xx answers other than auth, timeouts, halts and rate limits will not succeed on a retry. */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 408, 423, 429].includes(status)
}
