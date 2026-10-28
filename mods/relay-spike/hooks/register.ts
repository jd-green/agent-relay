import { atom, read, update } from 'claude-code'
import type { JsonValue, On, Register, Timer } from 'claude-code'

import type { SpikeWake } from '../types'
import { type RelayConfig, errorText, readConfig, sha256Prefix, withTimeout } from './relay'
import { Reporter, type SpikeHost } from './reporter'

/** How often the mod's main timer runs: flushes events, writes heartbeats, submits deferred wakes. */
const TICK_MS = 5_000
const HEARTBEAT_MS = 5 * 60_000
/** A submitted wake whose turn has not started by then is reported once and no longer blocks the next. */
const WAKE_START_TIMEOUT_MS = 2 * 60_000
const HEALTH_TIMEOUT_MS = 4_000
/** The most of the exit's short bound spent posting the last records. */
const EXIT_FLUSH_MS = 1_500

type Wake = { id: string; text: string }

/** The spike's engine calls, as closures over the session.start hook's `$`. */
type EngineHost = SpikeHost & {
  deferred: () => Promise<SpikeWake[]>
  updateDeferred: (change: (wakes: SpikeWake[]) => SpikeWake[]) => Promise<SpikeWake[]>
}

// Change the tag when the value's fields change: it declines what an earlier version stored.
const deferredState = atom({ plugin: 'relay-spike', key: 'deferred' } as const, [] as SpikeWake[], { shape: 'deferred-1' })

export const register: Register = (on, options) => {
  // Like a missing required field, an unusable value fails the load with a reason the person sees.
  registerSpike(on, readConfig('relay-spike', options, 30))
}

/** A value's SHA-256 prefix and length: two values compare without either being sent. */
const fingerprint = async (text: string): Promise<{ [key: string]: JsonValue }> => ({
  sha256: await sha256Prefix(text),
  length: text.length,
})

function registerSpike(on: On, config: RelayConfig): void {
  const reporter = new Reporter(config)
  const renderedSurfaces = new Set<string>()
  // The engine calls of the session.start hook, which the timers and later hooks reuse.
  let host: EngineHost | undefined
  let loops: Timer[] = []
  let isTicking = false
  let isTurnRunning = false
  let isSubmitting = false
  let queuedWake: { id: string; at: number } | undefined
  let nextHeartbeatAt = 0
  let wakePolls = 0
  // The marker's nonce follows the session, not the load: a reload (a /config change, a late load) keeps it.
  const nonces = new Map<string, string>()

  async function nonceFor(sessionId: string): Promise<string> {
    const known = nonces.get(sessionId)
    if (known !== undefined) return known
    const nonce = await sha256Prefix(`relay-spike marker:${sessionId}`, 8)
    nonces.set(sessionId, nonce)
    return nonce
  }

  const markerOf = (nonce: string) =>
    `relay-spike marker: ${nonce}. (Added by the relay-spike Mod to check that injected context reaches you; ` +
    'mention it only when asked for the marker.)'

  async function tick(engine: EngineHost): Promise<void> {
    if (isTicking) return
    isTicking = true
    try {
      await reporter.refresh(engine)
      const now = await engine.now()
      if (queuedWake !== undefined && now - queuedWake.at > WAKE_START_TIMEOUT_MS) {
        const waited_s = Math.round((now - queuedWake.at) / 1000)
        reporter.record('wake.not_started', { wake_id: queuedWake.id, waited_s }, undefined, { uncapped: true })
        queuedWake = undefined
      }
      await submitDeferred(engine)
      if (now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + HEARTBEAT_MS
        reporter.record(
          'spike.heartbeat',
          {
            uptime_s: Math.round((Date.now() - reporter.startedAt) / 1000),
            turn_running: isTurnRunning,
            sent: reporter.sent,
            queued: reporter.queued,
            dropped: reporter.dropped,
            wake_polls: wakePolls,
            deferred_wakes: (await engine.deferred()).length,
            counts: Object.fromEntries(reporter.counts()),
          },
          undefined,
          { uncapped: true },
        )
      }
      await reporter.flush(engine)
    } catch (error) {
      reporter.noteError('tick', errorText(error))
    } finally {
      isTicking = false
    }
  }

  /** Asks the relay for this session's wake requests: each is submitted at once when idle, else deferred. */
  async function pollWakes(engine: EngineHost): Promise<void> {
    try {
      const sessionId = await engine.sessionId()
      const reply = await reporter.call(engine, `/spike/wake?session_id=${encodeURIComponent(sessionId)}`)
      wakePolls += 1
      if (!reply.ok) return
      for (const wake of readWakes(reply.result)) {
        const deferred = await engine.deferred()
        if (isTurnRunning || queuedWake !== undefined || isSubmitting || deferred.length > 0) await defer(engine, wake)
        else await submitWake(engine, wake)
      }
    } catch (error) {
      reporter.noteError('wake poll', errorText(error))
    }
  }

  /** Keeps a wake that came while the session was busy, to submit when it is next idle. */
  async function defer(engine: EngineHost, wake: Wake): Promise<void> {
    const deferredAt = await engine.now()
    await engine.updateDeferred(wakes => [...wakes.filter(one => one.id !== wake.id), { ...wake, deferredAt }])
    reporter.record('wake.deferred', { wake_id: wake.id, turn_running: isTurnRunning }, undefined, { uncapped: true })
  }

  /** Submits the oldest deferred wake once nothing runs: after a turn, or at a tick. */
  async function submitDeferred(engine: EngineHost): Promise<void> {
    if (isTurnRunning || queuedWake !== undefined || isSubmitting) return
    isSubmitting = true
    try {
      const [wake] = await engine.deferred()
      if (wake === undefined) return
      await engine.updateDeferred(wakes => wakes.filter(one => one.id !== wake.id))
      await submitWake(engine, wake, (await engine.now()) - wake.deferredAt)
    } finally {
      isSubmitting = false
    }
  }

  /** Submits a wake's text as a prompt; resolves at once, the prompt's own promise reporting how it went. */
  async function submitWake(engine: EngineHost, wake: Wake, deferredMs?: number): Promise<void> {
    queuedWake = { id: wake.id, at: await engine.now() }
    const detail = { wake_id: wake.id, text_length: wake.text.length }
    reporter.record(
      'wake.submitted',
      deferredMs === undefined ? detail : { ...detail, deferred_s: Math.round(deferredMs / 1000) },
      undefined,
      { uncapped: true },
    )
    // Resolves when the wake's turn starts; never awaited, so a turn that never starts blocks nothing.
    engine
      .submit(wake.text)
      .then(
        result => {
          if (result.drop === undefined) reporter.record('wake.turn_started', { wake_id: wake.id }, undefined, { uncapped: true })
          else reporter.record('wake.failed', { wake_id: wake.id, error: result.drop.slice(0, 300) }, undefined, { uncapped: true })
        },
        error => reporter.record('wake.failed', { wake_id: wake.id, error: errorText(error) }, undefined, { uncapped: true }),
      )
      .finally(() => {
        if (queuedWake?.id === wake.id) queuedWake = undefined
      })
  }

  /** The /relay-spike output: what was logged, and whether the relay answers. */
  async function report(engine: EngineHost): Promise<string> {
    const health = await withTimeout(
      engine,
      engine.fetch(`${config.url}/health`).then(
        response => (response.ok ? 'reachable' : `answered HTTP ${response.status}`),
        error => `unreachable (${errorText(error)})`,
      ),
      HEALTH_TIMEOUT_MS,
    )
    const token = {
      unknown: 'not used yet',
      accepted: 'accepted',
      rejected: 'rejected (401): check role_token',
    }[reporter.tokenState]
    const lastSent = reporter.lastSentAt === undefined ? '' : ` · last sent ${new Date(reporter.lastSentAt).toISOString()}`
    const lastError =
      reporter.lastError === undefined ? 'none' : `${new Date(reporter.lastError.at).toISOString()} ${reporter.lastError.text}`
    return [
      `relay-spike · marker nonce ${await nonceFor(await engine.sessionId())} · relay ${config.url}`,
      `relay: ${health ?? `no answer within ${HEALTH_TIMEOUT_MS / 1000}s`} · token: ${token}`,
      `events: ${reporter.sent} sent, ${reporter.queued} queued, ${reporter.dropped} dropped, ${reporter.rejected} rejected${lastSent}`,
      `wake polls: ${wakePolls} · deferred wakes: ${(await engine.deferred()).length} · turn running: ${isTurnRunning ? 'yes' : 'no'}`,
      `last error: ${lastError}`,
      'seen since load:',
      ...reporter.counts().map(([event, count]) => `  ${event} ${count}`),
    ].join('\n')
  }

  on('session.start', async ($, e, next) => {
    const engine: EngineHost = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, options) => $.clock.sleep(ms, options),
      now: () => $.clock.now(),
      sessionId: () => $.session.id(),
      surfaces: () => $.session.surfaces(),
      submit: text => $.prompt.submit({ text }),
      deferred: () => read($, deferredState),
      updateDeferred: change => update($, deferredState, change),
    }
    host = engine
    try {
      await reporter.refresh(engine)
      reporter.record('session.start', {
        surface: e.surface ?? 'none',
        interactive: e.isInteractive,
        version: (await $.session.version()).version,
        entrypoint: (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? null,
        remote: (await $.env.get('CLAUDE_CODE_REMOTE')) ?? null,
        nonce: await nonceFor(await $.session.id()),
        cwd: await fingerprint(await $.session.cwd()),
      })
      await $.command.register({
        name: 'relay-spike',
        description: 'Show what the relay-spike Mod has logged and whether the relay is reachable',
      })
    } catch (error) {
      reporter.noteError('session.start', errorText(error))
    }
    for (const loop of loops) loop.cancel()
    loops = [
      $.clock.every(TICK_MS, () => void tick(engine)),
      // Wake polls run on their own timer, exactly every poll_seconds.
      $.clock.every(config.pollMs, () => void pollWakes(engine)),
    ]
    void pollWakes(engine).then(() => tick(engine))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    reporter.record('session.end', { reason: e.reason })
    // Best effort within the exit's short bound: the process may be gone before the POST lands. A relay
    // that just failed is not asked again: an abandoned request holds the process until the engine's timeout.
    if (host !== undefined && !reporter.isFailing) {
      const flushed = reporter.flush(host).catch(error => reporter.noteError('session.end', errorText(error)))
      await withTimeout(host, flushed, Math.max(0, Math.min(EXIT_FLUSH_MS, next.budget.remainingMs - 500)))
    }
    return next(e)
  })

  on('session.receive', ($, e, next) => {
    reporter.record(
      'session.receive',
      { origin: e.origin.kind, text_length: e.text.length, event_source: e.event?.source ?? null },
      e.agentId,
    )
    return next(e)
  })

  on('session.attach', ($, e, next) => {
    reporter.record('session.attach', { surface: e.surface })
    return next(e)
  })

  on('session.detach', ($, e, next) => {
    reporter.record('session.detach', { surface: e.surface, reason: e.reason })
    return next(e)
  })

  on('session.compact', ($, e, next) => {
    reporter.record('session.compact', { trigger: e.trigger }, e.agentId)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    reporter.record('turn.start', { text_length: e.text.length }, e.agentId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    reporter.record(
      'turn.complete',
      { reason: e.reason, duration_ms: e.durationMs, answer_length: e.answer.length },
      e.agentId,
    )
    if (e.agentId === undefined) {
      isTurnRunning = false
      // Idle again: a wake that came during the turn goes now, submitted before this hook settles,
      // since a headless run ends right after its turn unless a prompt is already queued.
      const engine = host
      if (engine !== undefined) await submitDeferred(engine).catch(error => reporter.noteError('deferred wake', errorText(error)))
    }
    return next(e)
  })

  // The injection probe: every prompt carries the marker as context the model reads and the person never sees.
  on('prompt.submit', async ($, e, next) => {
    reporter.record('prompt.submit', {
      origin: e.origin.kind,
      text_length: e.text.length,
      meta: e.isMeta === true,
      command: e.command?.name ?? null,
      mid_turn: e.turnId !== undefined,
    })
    if (e.command !== undefined) return next(e)
    const nonce = await nonceFor(await $.session.id())
    const result = await next({ ...e, context: [...(e.context ?? []), markerOf(nonce)] })
    if (result.drop === undefined) reporter.record('context.injected', { nonce, via: 'prompt.submit' })
    return result
  })

  // Which context blocks a conversation carries, and fingerprints (never the text) of the attached
  // Project's block and the directory: whether a Mod can tell one Project's threads from another's.
  on('prompt.context', async ($, e, next) => {
    const project = e.blocks.find(block => block.name === 'attachedProject')
    reporter.record('prompt.context', {
      blocks: e.blocks.map(block => block.name),
      attached_project: project === undefined ? null : await fingerprint(project.text),
      cwd: await fingerprint(await $.session.cwd()),
    })
    return next(e)
  })

  on('prompt.compose', ($, e, next) => {
    reporter.record('prompt.compose')
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    reporter.record('tool.call', { tool: String(e.tool) }, e.agentId)
    return next(e)
  })

  on('agent.spawn', ($, e, next) => {
    reporter.record('agent.spawn', { type: e.subagentType, background: e.background })
    return next(e)
  })

  on('command.run', ($, e, next) => {
    reporter.record('command.run', { command: e.command, origin: e.origin.kind, args_length: e.args.length })
    return next(e)
  })

  on('command.run', { command: 'relay-spike' }, async () => ({
    text: host === undefined ? 'relay-spike has not started yet.' : await report(host),
  }))

  // Whether the band above the prompt is drawn on this surface at all; once per surface.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!renderedSurfaces.has(e.surface)) {
      renderedSurfaces.add(e.surface)
      reporter.record('ui.render.AbovePrompt', { surface: e.surface })
    }
    return next(e)
  })
}

function readWakes(result: unknown): Wake[] {
  const wakes = (result as { wakes?: unknown } | null)?.wakes
  if (!Array.isArray(wakes)) return []
  return wakes.flatMap(wake =>
    typeof wake?.id === 'string' && typeof wake?.text === 'string' ? [{ id: wake.id, text: wake.text }] : [],
  )
}
