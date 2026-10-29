import type { PromptSubmitResult } from 'claude-code'

import type { RelayBuild, RelayInbox, RelayMemory, RelayMessage } from '../types'
import {
  type ParsedInbox,
  type Recovery,
  deliverableBuilds,
  formatForModel,
  formatForPerson,
  formatRecovery,
  keyOf,
  mergeMessages,
  newest,
  parseInbox,
  recoveryOf,
  replyPlan,
  rowWakeText,
  statusLine,
  token,
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

/** Messages reads handed over, marked read on the relay, with what the model is told beside them. */
export type Handed = { messages: RelayMessage[]; builds: RelayBuild[]; role: string | null; halted: string | null }

/** A prompt's hand-over: what its reads returned, and the reads that did not answer in time (`late`). */
export type Taken = Handed & { late: Recovery[] }

/** The longest a prompt waits for the relay, its peek and its read together; past it the prompt goes without. */
export const TAKE_TIMEOUT_MS = 1_500
/** No read starts with less of the prompt's time left: it would likely mark mail read after the prompt went. */
export const MIN_READ_MS = 700
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
 * for its prompt (or a prompt that did not enter) is added to the conversation. A prompt
 * whose read timed out carries instead the cursor that lists those messages again.
 */
export class Inbox {
  /** Set by the mod's turn hooks: a main-loop turn is running. */
  isTurnRunning = false
  /** Prompt hand-overs and /relay reads under way: no wake while one may be carrying the unread mail. */
  private taking = 0
  /**
   * Keys of messages in flight, counted per holder: listed by the peek of a read that has not
   * settled (a read that timed out may have marked them read, and its late answer hands them
   * over), or returned by a prompt's read and not yet recorded as handed over. No wake for them.
   */
  private readonly carrying = new Map<string, number>()
  /** Messages added to the conversation as a row that no main-loop model request has carried yet. */
  private unseen: RelayMessage[] = []

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
   * The prompt.submit hook's work for a prompt that starts a turn: takes the unread mail
   * and enters the prompt (`enter`) with the context blocks that carry it. Messages the
   * reads marked read reach the model either way: in the prompt, or as a row when it did
   * not enter. No wake goes out for them meanwhile.
   */
  async carry(host: InboxHost, enter: (blocks: readonly string[]) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
    this.taking += 1
    try {
      const taken = await this.take(host)
      if (taken === undefined) return await enter([])
      const keys = taken.messages.map(keyOf)
      this.hold(keys)
      const blocks = [
        ...(taken.messages.length > 0 ? [formatForModel(taken.messages, taken.builds, taken.role, taken.halted)] : []),
        ...(taken.late.length > 0 ? [formatRecovery(taken.late)] : []),
      ]
      let result: PromptSubmitResult
      try {
        result = await enter(blocks)
      } catch (error) {
        this.handOverLater(host, taken, keys)
        throw error
      }
      if (result.drop !== undefined) this.handOverLater(host, taken, keys)
      else {
        await this.delivered(host, taken.messages)
        this.release(keys)
      }
      return result
    } finally {
      this.taking -= 1
    }
  }

  /**
   * The hand-over for one prompt, within TAKE_TIMEOUT_MS: a fresh peek, then a read
   * (`peek: false`) of each build whose mail may be delivered. What those reads return,
   * now marked read, is exactly what the prompt carries, with a recovery line for each
   * read that did not answer in time (it may still have marked mail read). `undefined`
   * (the prompt carries nothing, nothing is read, the model's own inbox call covers it)
   * when the relay is failing or slow, less than MIN_READ_MS is left for the reads, the
   * kill switch is on, every build with unread mail is halted, or nothing is unread.
   */
  async take(host: InboxHost): Promise<Taken | undefined> {
    const startedAt = await host.now()
    if (this.failures > 0 && startedAt < this.nextPollAt) return undefined
    const peeked = await withTimeout(host, this.poll(host), TAKE_TIMEOUT_MS)
    if (peeked === undefined) return undefined
    const buildIds = deliverableBuilds(peeked)
    const left = startedAt + TAKE_TIMEOUT_MS - (await host.now())
    if (buildIds.length === 0 || left < MIN_READ_MS) return undefined
    const replies = await Promise.all(
      buildIds.map(async buildId => ({ buildId, reply: await this.read(host, buildId, left, peeked.messages) })),
    )
    const reads = replies.flatMap(({ reply }) => (reply.ok ? [parseInbox(reply.result)] : []))
    // Gone without an answer, the read may still have marked mail read: the model gets the cursor to list it again.
    const late = replies.flatMap(({ buildId, reply }) =>
      !reply.ok && reply.code === 'timeout' ? [recoveryOf(buildId, peeked.messages)] : [],
    )
    const messages = mergeMessages([], reads.flatMap(read => read.messages))
    if (messages.length === 0 && late.length === 0) return undefined
    // The kill switch went on between the peek and the read: these are read now, so the model gets them, told so.
    const halted = reads.find(read => read.halted !== null)?.halted ?? null
    return { messages, builds: peeked.builds, role: reads[0]?.role ?? peeked.role, halted, late }
  }

  /** A model request of a main-loop turn is about to go: it carries every row added so far. */
  stepped(): void {
    this.unseen = []
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
   * conversation, which the model reads at its next request. With no turn left to make
   * one, a wake starts a turn for it.
   */
  async handOver(host: InboxHost, handed: Handed): Promise<void> {
    const isAppended = await host.append(formatForModel(handed.messages, handed.builds, handed.role, handed.halted))
    // Before anything else is awaited: a model request from here on carries the row (see stepped).
    if (isAppended) this.unseen = mergeMessages(this.unseen, handed.messages)
    const ids = handed.messages.map(message => token(message.id)).join(', ')
    host.log(
      isAppended
        ? `relay-inbox: ${ids} were read on the relay with no prompt to carry them, so they were added to the conversation`
        : `relay-inbox: ${ids} are read on the relay but could not be added to the conversation; /relay lists them`,
    )
    await this.delivered(host, handed.messages)
    if (isAppended) await this.maybeWake(host)
  }

  /**
   * Submits a wake prompt when every guard allows it: idle, no prompt or /relay read under
   * way, no wake queued, past the start's grace. A row added to the conversation that no
   * model request has carried yet wakes at once (it is read on the relay, so no peek can
   * see it). Otherwise only a new batch still unread on the relay wakes, the gap kept.
   */
  async maybeWake(host: InboxHost): Promise<void> {
    if (!this.autoWake || this.isTurnRunning || this.isWaking || this.taking > 0) return
    this.isWaking = true
    try {
      const now = await host.now()
      if (now < this.wakesFrom) return
      if (this.wakeQueuedAt !== undefined && now - this.wakeQueuedAt < WAKE_START_TIMEOUT_MS) return
      if (this.unseen.length > 0) {
        // Held while a halt covers the rows' builds, like any wake; the wake's turn carries every row added
        // until its first request, so none is left unseen.
        const { halted, builds } = await host.inbox()
        if (deliverableBuilds({ halted, builds, messages: this.unseen }).length === 0) return
        if (await this.queueWake(host, rowWakeText(this.unseen), this.unseen.map(keyOf), now)) this.unseen = []
        return
      }
      if (wakeFor(await host.inbox(), await host.memory(), now, new Set(this.carrying.keys())) === undefined) return
      // Only for messages still unread on the relay: an older peek is made again first.
      if (now - this.lastPeekAt > FRESH_PEEK_MS && (await this.poll(host)) === undefined) return
      const wake = wakeFor(await host.inbox(), await host.memory(), await host.now(), new Set(this.carrying.keys()))
      if (wake === undefined) return
      await this.queueWake(host, wake.text, wake.keys, now)
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
    this.taking += 1
    try {
      const peeked = await this.poll(host)
      if (peeked === undefined) {
        const [inbox, memory] = [await host.inbox(), await host.memory()]
        const why = inbox.health.kind === 'failing' ? inbox.health.message : inbox.health.kind
        const cached = formatForPerson({ read: inbox.unread, held: [], isCached: true }, inbox, memory)
        return { text: `The relay did not answer (${why}). Last known:\n${cached}` }
      }
      const buildIds = deliverableBuilds(peeked)
      const replies = await Promise.all(
        buildIds.map(async buildId => ({ buildId, reply: await this.read(host, buildId, REQUEST_TIMEOUT_MS, peeked.messages) })),
      )
      const reads = replies.flatMap(({ reply }) => (reply.ok ? [parseInbox(reply.result)] : []))
      const late = replies.flatMap(({ buildId, reply }) =>
        !reply.ok && reply.code === 'timeout' ? [recoveryOf(buildId, peeked.messages)] : [],
      )
      const read = mergeMessages([], reads.flatMap(one => one.messages))
      const held = peeked.messages.filter(message => !buildIds.includes(message.build_id))
      await this.delivered(host, read)
      const text = formatForPerson({ read, held }, await host.inbox(), await host.memory(), late)
      const halted = reads.find(one => one.halted !== null)?.halted ?? null
      const context = [
        ...(read.length > 0 ? [formatForModel(read, peeked.builds, peeked.role, halted)] : []),
        ...(late.length > 0 ? [formatRecovery(late)] : []),
      ]
      return context.length > 0 ? { text, context } : { text }
    } finally {
      this.taking -= 1
    }
  }

  /**
   * /relay-reply: a `status` message to the sender of the newest message, in its build,
   * replying to it and naming its task, so an answer to a nudge counts as activity on it.
   * Never to this session's own role: a nudge sent on behalf of it is answered with a
   * ledger_update note, and a relay notice has nobody to answer; for those it says so.
   */
  async reply(host: InboxHost, text: string): Promise<string> {
    await this.poll(host)
    const plan = replyPlan(await host.inbox(), await host.memory())
    if (plan === undefined) return 'No relay message to reply to yet.'
    if (plan.to === undefined) return plan.why
    const { message: target, to } = plan
    if (text.trim() === '') {
      return `Usage: /relay-reply <text> (replies to ${token(to)}'s ${token(target.id)} in ${token(target.build_id)})`
    }
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
    return `Sent ${typeof id === 'string' ? token(id) : 'the reply'} to ${token(to)} (reply to ${token(target.id)}, build ${token(target.build_id)}).`
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

  /**
   * Reads one build's unread messages and marks them read; an answer that comes after `timeoutMs`
   * is handed over by itself. Until the read settles, the build's messages the peek `listed` wake
   * nothing: once it timed out they may be read already, and its late answer brings them.
   */
  private async read(host: InboxHost, buildId: string, timeoutMs: number, listed: readonly RelayMessage[]): Promise<RelayReply> {
    const keys = listed.filter(message => message.build_id === buildId).map(keyOf)
    this.hold(keys)
    try {
      const body = { build_id: buildId, peek: false, limit: 100, session_ref: await host.sessionId() }
      const reply = await relayRequest(host, this.config, '/api/call/inbox', { method: 'POST', body }, {
        timeoutMs,
        onLate: late => {
          const handed = late.ok ? parseInbox(late.result) : undefined
          if (handed === undefined || handed.messages.length === 0) return this.release(keys)
          this.background(host, () => this.handOver(host, handed).finally(() => this.release(keys)))
        },
      })
      // A read given up on settles only with its late answer (onLate), which releases them then.
      if (reply.ok || reply.code !== 'timeout') this.release(keys)
      return reply
    } catch (error) {
      this.release(keys)
      throw error
    }
  }

  /**
   * Records the wake and submits it, false when a turn or a prompt's read began while the guards
   * were checked (that one carries the mail). The submission resolves as the wake's turn starts,
   * so it is never awaited.
   */
  private async queueWake(host: InboxHost, text: string, keys: readonly string[], now: number): Promise<boolean> {
    if (this.isTurnRunning || this.taking > 0) return false
    await host.updateMemory(memory => ({ ...memory, woken: newest([...memory.woken, ...keys]), lastWakeAt: now }))
    this.wakeQueuedAt = now
    host
      .submit(text)
      .then(
        result => {
          if (result.drop !== undefined) host.log(`relay-inbox: the wake prompt was dropped: ${result.drop}`)
        },
        error => host.log(`relay-inbox: the wake prompt was refused: ${errorText(error)}`),
      )
      .finally(() => {
        this.wakeQueuedAt = undefined
      })
    return true
  }

  /** Hands a prompt's read over as a row after its prompt did not enter; no wake for it until that is done. */
  private handOverLater(host: InboxHost, taken: Taken, keys: readonly string[]): void {
    if (taken.messages.length === 0) return this.release(keys)
    this.background(host, () => this.handOver(host, taken).finally(() => this.release(keys)))
  }

  private hold(keys: readonly string[]): void {
    for (const key of keys) this.carrying.set(key, (this.carrying.get(key) ?? 0) + 1)
  }

  private release(keys: readonly string[]): void {
    for (const key of keys) {
      const count = (this.carrying.get(key) ?? 0) - 1
      if (count > 0) this.carrying.set(key, count)
      else this.carrying.delete(key)
    }
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
