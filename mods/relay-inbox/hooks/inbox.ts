import type { PromptSubmitResult } from 'claude-code'

import type { RelayBuild, RelayInbox, RelayMemory, RelayMessage } from '../types'
import {
  type ParsedInbox,
  deliverableBuilds,
  formatForModel,
  formatForPerson,
  keyOf,
  mergeMessages,
  newest,
  parseInbox,
  replyRole,
  replyTarget,
  statusLine,
  wakeFor,
} from './messages'
import { type Host, type RelayConfig, type RelayReply, REQUEST_TIMEOUT_MS, errorText, relayRequest, withTimeout } from './relay'

/** What the inbox needs from the engine, as closures over the session.start hook's `$`. */
export type InboxHost = Host & {
  sessionId: () => Promise<string>
  submit: (text: string) => Promise<PromptSubmitResult>
  /** Adds a user-role row the model reads at its next request; false when it was refused. */
  append: (text: string) => Promise<boolean>
  status: (text: string) => void
  log: (text: string) => void
  inbox: () => Promise<RelayInbox>
  memory: () => Promise<RelayMemory>
  updateInbox: (change: (inbox: RelayInbox) => RelayInbox) => Promise<RelayInbox>
  updateMemory: (change: (memory: RelayMemory) => RelayMemory) => Promise<RelayMemory>
}

/** Messages one read handed over, marked read on the relay, with what the model is told beside them. */
export type Taken = { messages: RelayMessage[]; builds: RelayBuild[]; role: string | null; halted: string | null }

/** The longest a prompt waits for the relay, its peek and its read together; past it the prompt goes without. */
export const TAKE_TIMEOUT_MS = 1_500
const MAX_BACKOFF_MS = 10 * 60_000
/** A wake prompt whose turn has not started by then no longer holds back the next one. */
const WAKE_START_TIMEOUT_MS = 2 * 60_000
/** No wake this soon after the session starts: a prompt already on its way (a headless run's, the person's first) goes first. */
const WAKE_GRACE_MS = 10_000
/** A peek this recent stands for the relay's state when a wake is decided; an older one is made again. */
const FRESH_PEEK_MS = 2_000
/** A poll beat this much early still counts as due (the timer's own jitter). */
const POLL_SLACK_MS = 1_000
const RECENT_LIMIT = 20

/**
 * The inbox's behaviour: peek polls (band, status line, wakes), the atomic hand-over
 * of unread messages to a prompt, auto-wake and replies. What must survive a reload
 * lives in `$.state` (through the host); only timing state is kept here.
 *
 * A message is marked read only by a read whose answer the model is given: the
 * prompt's context carries what the read returned, and a read that answers too late
 * for its prompt (or a prompt that did not enter) is added to the conversation.
 */
export class Inbox {
  /** Set by the mod's turn hooks: a main-loop turn is running. */
  isTurnRunning = false

  private readonly config: RelayConfig
  private readonly autoWake: boolean
  private failures = 0
  private nextPollAt = 0
  private lastPeekAt = Number.NEGATIVE_INFINITY
  private wakesFrom = 0
  private wakeQueuedAt: number | undefined
  private isWaking = false
  private polling: Promise<ParsedInbox | undefined> | undefined

  constructor(config: RelayConfig, autoWake: boolean) {
    this.config = config
    this.autoWake = autoWake
  }

  /** Marks the session's start, from which the wake grace runs. */
  async begin(host: InboxHost): Promise<void> {
    this.wakesFrom = (await host.now()) + WAKE_GRACE_MS
  }

  /** Runs work nobody waits for (a timer beat, a hook's follow-up); a failure is logged, never thrown. */
  background(host: InboxHost, work: () => Promise<void>): void {
    work().catch(error => {
      try {
        host.log(`relay-inbox: ${errorText(error)}`)
      } catch {
        // The session is going away: there is nowhere left to say it.
      }
    })
  }

  /** One beat of the poll timer, every poll_seconds: poll unless a failing relay is backed off from, then consider a wake. */
  async beat(host: InboxHost): Promise<void> {
    if ((await host.now()) + POLL_SLACK_MS >= this.nextPollAt) await this.poll(host)
    await this.maybeWake(host)
  }

  /**
   * After each main-loop turn: re-read the inbox (the model may have read its
   * messages through the relay's own inbox tool), then consider a wake. A relay
   * that is failing is left to its backoff.
   */
  async afterTurn(host: InboxHost): Promise<void> {
    if (this.failures === 0) await this.poll(host)
    await this.maybeWake(host)
  }

  /** Peeks at the unread messages (no side effects on the relay). A peek already under way is shared. */
  poll(host: InboxHost): Promise<ParsedInbox | undefined> {
    this.polling ??= this.peek(host).finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  /**
   * The hand-over for one prompt, within TAKE_TIMEOUT_MS: a fresh peek, then a read
   * (`peek: false`) of each build whose mail may be delivered. What those reads return,
   * now marked read, is exactly what the prompt carries. `undefined` (the prompt carries
   * nothing, the model's own inbox call covers it) when the relay is failing or slow,
   * the kill switch is on, every build with unread mail is halted, or nothing is unread.
   */
  async take(host: InboxHost): Promise<Taken | undefined> {
    const startedAt = await host.now()
    if (this.failures > 0 && startedAt < this.nextPollAt) return undefined
    const peeked = await withTimeout(host, this.poll(host), TAKE_TIMEOUT_MS)
    if (peeked === undefined) return undefined
    const buildIds = deliverableBuilds(peeked)
    const left = startedAt + TAKE_TIMEOUT_MS - (await host.now())
    if (buildIds.length === 0 || left <= 0) return undefined
    const reads = (await Promise.all(buildIds.map(buildId => this.read(host, buildId, left)))).flatMap(reply =>
      reply.ok ? [parseInbox(reply.result)] : [],
    )
    const messages = mergeMessages([], reads.flatMap(read => read.messages))
    if (messages.length === 0) return undefined
    // The kill switch went on between the peek and the read: these are read now, so the model gets them, told so.
    const halted = reads.find(read => read.halted !== null)?.halted ?? null
    return { messages, builds: peeked.builds, role: reads[0]?.role ?? peeked.role, halted }
  }

  /** Records that `messages` are in the model's context now: /relay lists them, the band no longer does. */
  async delivered(host: InboxHost, messages: readonly RelayMessage[]): Promise<void> {
    const keys = new Set(messages.map(keyOf))
    await host.updateMemory(memory => ({ ...memory, recent: newest(mergeMessages(memory.recent, messages), RECENT_LIMIT) }))
    await this.setInbox(host, inbox => ({ ...inbox, unread: inbox.unread.filter(message => !keys.has(keyOf(message))) }))
  }

  /**
   * Hands over messages a read marked read that no prompt carried (the prompt did not
   * enter, or the read answered after its prompt went): a user-role row of the
   * conversation, which the model reads at its next request.
   */
  async handOver(host: InboxHost, taken: Taken): Promise<void> {
    const isAppended = await host.append(formatForModel(taken.messages, taken.builds, taken.role, taken.halted))
    const ids = taken.messages.map(message => message.id).join(', ')
    host.log(
      isAppended
        ? `relay-inbox: ${ids} were read on the relay with no prompt to carry them, so they were added to the conversation`
        : `relay-inbox: ${ids} are read on the relay but could not be added to the conversation; /relay lists them`,
    )
    await this.delivered(host, taken.messages)
  }

  /** Submits the wake prompt when every guard allows it: idle, not halted, a new batch still unread, the gap kept. */
  async maybeWake(host: InboxHost): Promise<void> {
    if (!this.autoWake || this.isTurnRunning || this.isWaking) return
    this.isWaking = true
    try {
      const now = await host.now()
      if (now < this.wakesFrom) return
      if (this.wakeQueuedAt !== undefined && now - this.wakeQueuedAt < WAKE_START_TIMEOUT_MS) return
      if (wakeFor(await host.inbox(), await host.memory(), now) === undefined) return
      // Only for messages still unread on the relay: an older peek is made again first.
      if (now - this.lastPeekAt > FRESH_PEEK_MS && (await this.poll(host)) === undefined) return
      const wake = wakeFor(await host.inbox(), await host.memory(), await host.now())
      if (wake === undefined || this.isTurnRunning) return
      await host.updateMemory(memory => ({ ...memory, woken: newest([...memory.woken, ...wake.keys]), lastWakeAt: now }))
      this.wakeQueuedAt = now
      // Resolves as the wake's turn starts, so it is never awaited.
      host
        .submit(wake.text)
        .then(
          result => {
            if (result.drop !== undefined) host.log(`relay-inbox: the wake prompt was dropped: ${result.drop}`)
          },
          error => host.log(`relay-inbox: the wake prompt was refused: ${errorText(error)}`),
        )
        .finally(() => {
          this.wakeQueuedAt = undefined
        })
    } finally {
      this.isWaking = false
    }
  }

  /**
   * /relay: reads (and so marks read) the unread messages of every build not held by
   * a halt, lists them and the last few earlier ones for the person, and hands what
   * it read to the model. While halted, it lists without reading.
   */
  async show(host: InboxHost): Promise<{ text: string; context?: string[] }> {
    const peeked = await this.poll(host)
    if (peeked === undefined) {
      const [inbox, memory] = [await host.inbox(), await host.memory()]
      const why = inbox.health.kind === 'failing' ? inbox.health.message : inbox.health.kind
      const cached = formatForPerson({ read: inbox.unread, held: [], isCached: true }, inbox, memory)
      return { text: `The relay did not answer (${why}). Last known:\n${cached}` }
    }
    const buildIds = deliverableBuilds(peeked)
    const reads = (await Promise.all(buildIds.map(buildId => this.read(host, buildId, REQUEST_TIMEOUT_MS)))).flatMap(reply =>
      reply.ok ? [parseInbox(reply.result)] : [],
    )
    const read = mergeMessages([], reads.flatMap(one => one.messages))
    const held = peeked.messages.filter(message => !buildIds.includes(message.build_id))
    await this.delivered(host, read)
    const text = formatForPerson({ read, held }, await host.inbox(), await host.memory())
    const halted = reads.find(one => one.halted !== null)?.halted ?? null
    return read.length > 0 ? { text, context: [formatForModel(read, peeked.builds, peeked.role, halted)] } : { text }
  }

  /**
   * /relay-reply: a `status` message to the sender of the newest message, in its build,
   * replying to it and naming its task, so an answer to a nudge counts as activity on it.
   */
  async reply(host: InboxHost, text: string): Promise<string> {
    await this.poll(host)
    const target = replyTarget(await host.inbox(), await host.memory())
    if (target === undefined) return 'No relay message to reply to yet.'
    const to = replyRole(target) ?? target.from
    if (text.trim() === '') return `Usage: /relay-reply <text> (replies to ${to}'s ${target.id} in ${target.build_id})`
    const sent = await relayRequest(host, this.config, '/api/call/send', {
      method: 'POST',
      body: {
        build_id: target.build_id,
        to_role: to,
        type: 'status',
        body: text.trim(),
        reply_to: target.id,
        ...(target.task_id === null ? {} : { task_id: target.task_id }),
      },
    })
    if (!sent.ok) return `The relay did not take the reply (${sent.code}: ${sent.message}).`
    const id = (sent.result as { message?: { id?: unknown } } | null)?.message?.id
    return `Sent ${typeof id === 'string' ? id : 'the reply'} to ${to} (reply to ${target.id}, build ${target.build_id}).`
  }

  /** Redraws the status line from the stored inbox, e.g. after a reload. */
  async showStatus(host: InboxHost): Promise<void> {
    host.status(statusLine(await host.inbox(), await host.now()))
  }

  private async peek(host: InboxHost): Promise<ParsedInbox | undefined> {
    const startedAt = await host.now()
    const sessionRef = encodeURIComponent(await host.sessionId())
    const reply = await relayRequest(host, this.config, `/api/inbox?peek=1&limit=100&session_ref=${sessionRef}`)
    if (!reply.ok) {
      await this.failed(host, reply, startedAt)
      return undefined
    }
    this.failures = 0
    // Only a failure holds the poll timer back: it polls at every beat, exactly every poll_seconds,
    // whatever extra peeks a prompt, a turn's end or a wake made in between.
    this.nextPollAt = 0
    this.lastPeekAt = await host.now()
    const parsed = parseInbox(reply.result)
    // A peek that left before a read answered can still list what that read handed over.
    const handed = new Set((await host.memory()).recent.map(keyOf))
    const unread = parsed.messages.filter(message => !handed.has(keyOf(message)))
    const { role, builds, halted } = parsed
    await this.setInbox(host, () => ({ role, unread, builds, halted, health: { kind: 'ok' } }))
    return { ...parsed, messages: unread }
  }

  /** Reads one build's unread messages and marks them read; an answer that comes after `timeoutMs` is handed over by itself. */
  private async read(host: InboxHost, buildId: string, timeoutMs: number): Promise<RelayReply> {
    const body = { build_id: buildId, peek: false, limit: 100, session_ref: await host.sessionId() }
    return relayRequest(host, this.config, '/api/call/inbox', { method: 'POST', body }, {
      timeoutMs,
      onLate: reply => {
        if (!reply.ok) return
        const { messages, builds, role, halted } = parseInbox(reply.result)
        if (messages.length > 0) this.background(host, () => this.handOver(host, { messages, builds, role, halted }))
      },
    })
  }

  private async failed(host: InboxHost, reply: Extract<RelayReply, { ok: false }>, startedAt: number): Promise<void> {
    this.failures += 1
    const isUnauthorized = reply.status === 401
    const delay = isUnauthorized ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, this.config.pollMs * 2 ** this.failures)
    // From the failed poll's start, so the retry lands on a beat of the poll timer.
    this.nextPollAt = startedAt + delay
    await this.setInbox(host, inbox => ({
      ...inbox,
      health: isUnauthorized
        ? { kind: 'unauthorized' }
        : { kind: 'failing', message: `${reply.code}: ${reply.message}`, retryAt: this.nextPollAt },
    }))
  }

  private async setInbox(host: InboxHost, change: (inbox: RelayInbox) => RelayInbox): Promise<RelayInbox> {
    const inbox = await host.updateInbox(change)
    host.status(statusLine(inbox, await host.now()))
    return inbox
  }
}
