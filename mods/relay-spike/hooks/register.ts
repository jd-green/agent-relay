import type { On, Register, Timer } from 'claude-code'

import { type RelayConfig, errorText, readConfig, withTimeout } from './relay'
import { Reporter, type SpikeHost } from './reporter'

/** How often the mod's one timer runs: flushes events, polls wakes when due, writes heartbeats. */
const TICK_MS = 5_000
const HEARTBEAT_MS = 5 * 60_000
/** A submitted wake whose turn has not started by then is reported once and no longer blocks the next. */
const WAKE_START_TIMEOUT_MS = 2 * 60_000
const HEALTH_TIMEOUT_MS = 4_000

type Wake = { id: string; text: string }

export const register: Register = (on, options) => {
  const config = readConfig(options, 30)
  // Like a missing required field, an unusable value fails the load with a reason the person sees.
  if (config === undefined) throw new Error('relay-spike: relay_url must be an http(s) URL and role_token must be set')
  registerSpike(on, config)
}

function registerSpike(on: On, config: RelayConfig): void {
  const reporter = new Reporter(config)
  const nonce = crypto.randomUUID().slice(0, 8)
  const marker =
    `relay-spike marker: ${nonce}. (Added by the relay-spike Mod to check that injected context reaches you; ` +
    'mention it only when asked for the marker.)'
  const renderedSurfaces = new Set<string>()
  // The engine calls of the session.start hook, which the timer and later hooks reuse.
  let host: SpikeHost | undefined
  let loop: Timer | undefined
  let isTicking = false
  let isTurnRunning = false
  let queuedWake: { id: string; at: number } | undefined
  let nextPollAt = 0
  let nextHeartbeatAt = 0
  let wakePolls = 0

  async function tick(engine: SpikeHost): Promise<void> {
    if (isTicking) return
    isTicking = true
    try {
      await reporter.refresh(engine)
      const now = await engine.now()
      if (queuedWake !== undefined && now - queuedWake.at > WAKE_START_TIMEOUT_MS) {
        reporter.record('wake.not_started', { wake_id: queuedWake.id, waited_s: Math.round((now - queuedWake.at) / 1000) })
        queuedWake = undefined
      }
      if (now >= nextPollAt) {
        nextPollAt = now + config.pollMs
        await pollWakes(engine)
      }
      if (now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + HEARTBEAT_MS
        reporter.record('spike.heartbeat', {
          uptime_s: Math.round((Date.now() - reporter.startedAt) / 1000),
          turn_running: isTurnRunning,
          sent: reporter.sent,
          queued: reporter.queued,
          dropped: reporter.dropped,
          wake_polls: wakePolls,
          counts: Object.fromEntries(reporter.counts()),
        })
      }
      await reporter.flush(engine)
    } catch (error) {
      reporter.noteError('tick', errorText(error))
    } finally {
      isTicking = false
    }
  }

  /** Asks the relay for wake requests and submits each one as a prompt when no turn is running. */
  async function pollWakes(engine: SpikeHost): Promise<void> {
    const query = reporter.sessionId === undefined ? '' : `?session_id=${encodeURIComponent(reporter.sessionId)}`
    const reply = await reporter.call(engine, `/spike/wake${query}`)
    wakePolls += 1
    if (!reply.ok) return
    for (const wake of readWakes(reply.result)) {
      if (isTurnRunning || queuedWake !== undefined) {
        reporter.record('wake.skipped_busy', { wake_id: wake.id })
        continue
      }
      queuedWake = { id: wake.id, at: await engine.now() }
      reporter.record('wake.submitted', { wake_id: wake.id, text_length: wake.text.length })
      // Resolves when the wake's turn starts; never awaited, so a turn that never starts blocks nothing.
      engine
        .submit(wake.text)
        .then(
          result => {
            if (result.drop === undefined) reporter.record('wake.turn_started', { wake_id: wake.id })
            else reporter.record('wake.failed', { wake_id: wake.id, error: result.drop.slice(0, 300) })
          },
          error => reporter.record('wake.failed', { wake_id: wake.id, error: errorText(error) }),
        )
        .finally(() => {
          if (queuedWake?.id === wake.id) queuedWake = undefined
        })
    }
  }

  /** The /relay-spike output: what was logged, and whether the relay answers. */
  async function report(engine: SpikeHost): Promise<string> {
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
      `relay-spike · marker nonce ${nonce} · relay ${config.url}`,
      `relay: ${health ?? `no answer within ${HEALTH_TIMEOUT_MS / 1000}s`} · token: ${token}`,
      `events: ${reporter.sent} sent, ${reporter.queued} queued, ${reporter.dropped} dropped, ${reporter.rejected} rejected${lastSent}`,
      `wake polls: ${wakePolls} · turn running: ${isTurnRunning ? 'yes' : 'no'}`,
      `last error: ${lastError}`,
      'seen since load:',
      ...reporter.counts().map(([event, count]) => `  ${event} ${count}`),
    ].join('\n')
  }

  on('session.start', async ($, e, next) => {
    const engine: SpikeHost = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, options) => $.clock.sleep(ms, options),
      now: () => $.clock.now(),
      sessionId: () => $.session.id(),
      surfaces: () => $.session.surfaces(),
      submit: text => $.prompt.submit({ text }),
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
        nonce,
      })
      await $.command.register({
        name: 'relay-spike',
        description: 'Show what the relay-spike Mod has logged and whether the relay is reachable',
      })
    } catch (error) {
      reporter.noteError('session.start', errorText(error))
    }
    loop?.cancel()
    loop = $.clock.every(TICK_MS, () => void tick(engine))
    void tick(engine)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    reporter.record('session.end', { reason: e.reason })
    // Best effort within the exit's short bound: the process may be gone before the POST lands.
    if (host !== undefined) {
      const flushed = reporter.flush(host).catch(error => reporter.noteError('session.end', errorText(error)))
      await withTimeout(host, flushed, Math.max(0, Math.min(1_500, next.budget.remainingMs - 500)))
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

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false
    reporter.record(
      'turn.complete',
      { reason: e.reason, duration_ms: e.durationMs, answer_length: e.answer.length },
      e.agentId,
    )
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
    const result = await next({ ...e, context: [...(e.context ?? []), marker] })
    if (result.drop === undefined) reporter.record('context.injected', { nonce, via: 'prompt.submit' })
    return result
  })

  on('prompt.context', ($, e, next) => {
    reporter.record('prompt.context', { blocks: e.blocks.length })
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
