import type { PromptSubmitResult } from 'claude-code'

import type { RelayInbox, RelayMemory, RelayMessage } from '../types'
import {
  formatForModel,
  formatForPerson,
  keyOf,
  mergeMessages,
  newest,
  parseInbox,
  replyRole,
  replyTarget,
  statusLine,
  undelivered,
  wakeFor,
} from './messages'
import { type Host, type RelayConfig, type RelayReply, errorText, relayRequest } from './relay'

/** What the inbox needs from the engine, as closures over the session.start hook's `$`. */
export type InboxHost = Host & {
  sessionId: () => Promise<string>
  submit: (text: string) => Promise<PromptSubmitResult>
  status: (text: string) => void
  log: (text: string) => void
  inbox: () => Promise<RelayInbox>
  memory: () => Promise<RelayMemory>
  updateInbox: (change: (inbox: RelayInbox) => RelayInbox) => Promise<RelayInbox>
  updateMemory: (change: (memory: RelayMemory) => RelayMemory) => Promise<RelayMemory>
}

const MAX_BACKOFF_MS = 10 * 60_000
/** A wake prompt whose turn has not started by then no longer holds back the next one. */
const WAKE_START_TIMEOUT_MS = 2 * 60_000
/** No wake this soon after the session starts: a prompt already on its way (a headless run's, the person's first) goes first. */
const WAKE_GRACE_MS = 10_000
const RECENT_LIMIT = 20

/**
 * The inbox's behaviour: peek polls, handing unread messages to the model,
 * marking them read, auto-wake and replies. What must survive a reload lives in
 * `$.state` (through the host); only timing state is kept here.
 */
export class Inbox {
  /** Set by the mod's turn hooks: a main-loop turn is running. */
  isTurnRunning = false

  private readonly config: RelayConfig
  private readonly autoWake: boolean
  private failures = 0
  private nextPollAt = 0
  private wakesFrom = 0
  private wakeQueuedAt: number | undefined
  private isTicking = false
  private isPolling = false
  private isMarking = false

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

  /** One beat of the mod's timer: finish marking read, poll when due, then consider a wake. */
  async tick(host: InboxHost): Promise<void> {
    if (this.isTicking) return
    this.isTicking = true
    try {
      if ((await host.memory()).markReadPending) await this.markRead(host)
      if ((await host.now()) >= this.nextPollAt) await this.poll(host)
      await this.maybeWake(host)
    } finally {
      this.isTicking = false
    }
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

  /** Peeks at the unread messages (no side effects on the relay) and keeps the ones the model has not had. */
  async poll(host: InboxHost): Promise<void> {
    if (this.isPolling) return
    this.isPolling = true
    try {
      const sessionRef = encodeURIComponent(await host.sessionId())
      const reply = await relayRequest(host, this.config, `/api/inbox?peek=1&limit=100&session_ref=${sessionRef}`)
      const now = await host.now()
      if (!reply.ok) {
        await this.failed(host, reply, now)
        return
      }
      this.failures = 0
      this.nextPollAt = now + this.config.pollMs
      const parsed = parseInbox(reply.result)
      const memory = await host.memory()
      const delivered = new Set(memory.delivered)
      const unread = mergeMessages(
        memory.carried,
        parsed.messages.filter(message => !delivered.has(keyOf(message))),
      )
      await this.setInbox(host, () => ({ role: parsed.role, unread, builds: parsed.builds, halted: parsed.halted, health: { kind: 'ok' } }))
    } finally {
      this.isPolling = false
    }
  }

  /** Records that `messages` are in the model's context now; `markRead` then tells the relay. */
  async delivered(host: InboxHost, messages: readonly RelayMessage[], isMarkedRead: boolean): Promise<void> {
    const keys = new Set(messages.map(keyOf))
    await host.updateMemory(memory => ({
      ...memory,
      delivered: newest([...memory.delivered, ...keys]),
      carried: memory.carried.filter(message => !keys.has(keyOf(message))),
      recent: newest(mergeMessages(memory.recent, messages), RECENT_LIMIT),
      markReadPending: memory.markReadPending || !isMarkedRead,
    }))
    await this.setInbox(host, inbox => ({ ...inbox, unread: inbox.unread.filter(message => !keys.has(keyOf(message))) }))
  }

  /**
   * Marks this role's unread messages read on the relay. Anything that arrived
   * after the last peek is marked too, so it is carried to the next turn.
   */
  async markRead(host: InboxHost): Promise<void> {
    if (this.isMarking) return
    this.isMarking = true
    try {
      const reply = await this.readAndMark(host)
      if (!reply.ok) return
      const parsed = parseInbox(reply.result)
      let missed: RelayMessage[] = []
      await host.updateMemory(memory => {
        const delivered = new Set(memory.delivered)
        missed = parsed.messages.filter(message => !delivered.has(keyOf(message)))
        return { ...memory, markReadPending: false, carried: mergeMessages(memory.carried, missed) }
      })
      if (missed.length > 0) await this.setInbox(host, inbox => ({ ...inbox, unread: mergeMessages(inbox.unread, missed) }))
    } finally {
      this.isMarking = false
    }
  }

  /** Submits the wake prompt when every guard allows it: idle, not halted, a new batch, the gap kept. */
  async maybeWake(host: InboxHost): Promise<void> {
    if (!this.autoWake || this.isTurnRunning) return
    const now = await host.now()
    if (now < this.wakesFrom) return
    if (this.wakeQueuedAt !== undefined && now - this.wakeQueuedAt < WAKE_START_TIMEOUT_MS) return
    const wake = wakeFor(await host.inbox(), await host.memory(), now)
    if (wake === undefined) return
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
  }

  /** /relay: marks everything read, lists it for the person and hands the new messages to the model. */
  async show(host: InboxHost): Promise<{ text: string; context?: string[] }> {
    const reply = await this.readAndMark(host)
    if (!reply.ok) {
      const [inbox, memory] = [await host.inbox(), await host.memory()]
      const cached = formatForPerson(undelivered(inbox, memory), inbox, memory, false)
      return { text: `The relay did not answer (${reply.code}: ${reply.message}). Last known:\n${cached}` }
    }
    const parsed = parseInbox(reply.result)
    const delivered = new Set((await host.memory()).delivered)
    const fresh = mergeMessages((await host.inbox()).unread, parsed.messages).filter(message => !delivered.has(keyOf(message)))
    await this.delivered(host, fresh, true)
    const inbox = await this.setInbox(host, current => ({
      ...current,
      role: parsed.role,
      builds: parsed.builds,
      halted: parsed.halted,
      health: { kind: 'ok' },
    }))
    const text = formatForPerson(fresh, inbox, await host.memory(), true)
    return fresh.length > 0 ? { text, context: [formatForModel(fresh, parsed.builds, parsed.role)] } : { text }
  }

  /** /relay-reply: a `status` message to the sender of the newest message, in its build, replying to it. */
  async reply(host: InboxHost, text: string): Promise<string> {
    const target = replyTarget(await host.inbox(), await host.memory())
    if (target === undefined) return 'No relay message to reply to yet.'
    const to = replyRole(target) ?? target.from
    if (text.trim() === '') return `Usage: /relay-reply <text> (replies to ${to}'s ${target.id} in ${target.build_id})`
    const sent = await relayRequest(host, this.config, '/api/call/send', {
      method: 'POST',
      body: { build_id: target.build_id, to_role: to, type: 'status', body: text.trim(), reply_to: target.id },
    })
    if (!sent.ok) return `The relay did not take the reply (${sent.code}: ${sent.message}).`
    const id = (sent.result as { message?: { id?: unknown } } | null)?.message?.id
    return `Sent ${typeof id === 'string' ? id : 'the reply'} to ${to} (reply to ${target.id}, build ${target.build_id}).`
  }

  /** Redraws the status line from the stored inbox, e.g. after a reload. */
  async showStatus(host: InboxHost): Promise<void> {
    host.status(statusLine(await host.inbox(), await host.now()))
  }

  private async readAndMark(host: InboxHost): Promise<RelayReply> {
    return relayRequest(host, this.config, '/api/call/inbox', {
      method: 'POST',
      body: { peek: false, limit: 100, session_ref: await host.sessionId() },
    })
  }

  private async failed(host: InboxHost, reply: Extract<RelayReply, { ok: false }>, now: number): Promise<void> {
    this.failures += 1
    const isUnauthorized = reply.status === 401
    const delay = isUnauthorized ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, this.config.pollMs * 2 ** this.failures)
    this.nextPollAt = now + delay
    await this.setInbox(host, inbox => ({
      ...inbox,
      health: isUnauthorized
        ? { kind: 'unauthorized' }
        : { kind: 'failing', message: `${reply.code}: ${reply.message}`, retryAt: now + delay },
    }))
  }

  private async setInbox(host: InboxHost, change: (inbox: RelayInbox) => RelayInbox): Promise<RelayInbox> {
    const inbox = await host.updateInbox(change)
    host.status(statusLine(inbox, await host.now()))
    return inbox
  }
}
