import { atom, read, update } from 'claude-code'
import type { On, Register, Timer } from 'claude-code'

import type { RelayInbox, RelayMemory } from '../types'
import { Inbox, type InboxHost } from './inbox'
import { formatForModel, headline, undelivered } from './messages'
import { type RelayConfig, errorText, readConfig, withTimeout } from './relay'

/** How often the mod's timer runs; polls happen every poll_seconds within it. */
const TICK_MS = 5_000
/** How long the session's start waits for the first poll, so the first prompt can carry its messages. */
const FIRST_POLL_WAIT_MS = 3_000
/** The most of the exit's short bound spent marking delivered messages read. */
const EXIT_MARK_READ_MS = 1_500

const EMPTY_INBOX: RelayInbox = { role: null, unread: [], builds: [], halted: null, health: { kind: 'starting' } }
const EMPTY_MEMORY: RelayMemory = {
  delivered: [],
  woken: [],
  carried: [],
  recent: [],
  lastWakeAt: 0,
  markReadPending: false,
}
// Change a tag when that value's fields change: it declines what an earlier version stored.
const inboxState = atom({ plugin: 'relay-inbox', key: 'inbox' } as const, EMPTY_INBOX, { shape: 'inbox-1' })
const memoryState = atom({ plugin: 'relay-inbox', key: 'memory' } as const, EMPTY_MEMORY, { shape: 'memory-1' })

export const register: Register = (on, options) => {
  const config = readConfig(options, 60)
  // Like a missing required field, an unusable value fails the load with a reason the person sees.
  if (config === undefined) throw new Error('relay-inbox: relay_url must be an http(s) URL and role_token must be set')
  registerInbox(on, config, options.auto_wake !== false)
}

function registerInbox(on: On, config: RelayConfig, autoWake: boolean): void {
  const inbox = new Inbox(config, autoWake)
  // The engine calls of the session.start hook, which the timer and later hooks reuse.
  let host: InboxHost | undefined
  let loop: Timer | undefined

  on('session.start', async ($, e, next) => {
    const engine: InboxHost = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, options) => $.clock.sleep(ms, options),
      now: () => $.clock.now(),
      sessionId: () => $.session.id(),
      submit: text => $.prompt.submit({ text }),
      status: text => $.ui.status(text),
      log: text => $.ui.log(text, { to: 'debug' }),
      inbox: () => read($, inboxState),
      memory: () => read($, memoryState),
      updateInbox: change => update($, inboxState, change),
      updateMemory: change => update($, memoryState, change),
    }
    host = engine
    try {
      await inbox.begin(engine)
      await $.command.register({ name: 'relay', description: 'Show unread and recent Agent Relay messages and mark them read' })
      await $.command.register({
        name: 'relay-reply',
        description: 'Reply to the newest Agent Relay message with a status message',
        argumentHint: '<text>',
      })
      await inbox.showStatus(engine)
      await withTimeout(engine, inbox.poll(engine), FIRST_POLL_WAIT_MS)
    } catch (error) {
      $.ui.log(`relay-inbox: ${errorText(error)}`, { to: 'debug' })
    }
    loop?.cancel()
    loop = $.clock.every(TICK_MS, () => inbox.background(engine, () => inbox.tick(engine)))
    inbox.background(engine, () => inbox.tick(engine))
    return next(e)
  })

  // A headless run ends right after its turn: mark what it was given read, or the next run gets it again.
  on('session.end', async ($, e, next) => {
    const engine = host
    if (engine !== undefined && (await engine.memory()).markReadPending) {
      const marked = inbox.markRead(engine).catch(error => $.ui.log(`relay-inbox: ${errorText(error)}`, { to: 'debug' }))
      await withTimeout(engine, marked, Math.max(0, Math.min(EXIT_MARK_READ_MS, next.budget.remainingMs - 500)))
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) inbox.isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      inbox.isTurnRunning = false
      const engine = host
      if (engine !== undefined) inbox.background(engine, () => inbox.afterTurn(engine))
    }
    return next(e)
  })

  // Unread messages ride along with the next prompt as context the model reads, then are marked read.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || host === undefined) return next(e)
    const state = await read($, inboxState)
    const batch = undelivered(state, await read($, memoryState))
    if (batch.length === 0) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), formatForModel(batch, state.builds, state.role)] })
    if (result.drop === undefined) {
      const engine = host
      await inbox.delivered(engine, batch, false)
      inbox.background(engine, () => inbox.markRead(engine))
    }
    return result
  })

  on('command.run', { command: 'relay' }, async () =>
    host === undefined ? { text: 'relay-inbox has not started yet.' } : inbox.show(host),
  )

  on('command.run', { command: 'relay-reply' }, async ($, e) => ({
    text: host === undefined ? 'relay-inbox has not started yet.' : await inbox.reply(host, e.args),
  }))

  // Read runs /relay as a command. Raised from this hook rather than the Button's own handler, the run
  // passes through this mod's command.run hook, which answers it (a mod's own calls from a handler or a
  // timer skip its hooks).
  on('ui.press', { plugin: 'relay-inbox', element: 'read' }, ($, e, next) => {
    void $.command.run({ command: 'relay' }).catch(error => $.ui.log(`relay-inbox: ${errorText(error)}`, { to: 'debug' }))
    return next(e)
  })

  // The band above the prompt: drawn only while there are unread messages.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, inboxState)
    if (e.props.hasSurvey || state.unread.length === 0) return next(e)
    const newestMessage = state.unread[state.unread.length - 1]
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text wrap="truncate-end">
          Relay · {state.unread.length} unread{newestMessage ? ` · ${headline(newestMessage)}` : ''}{' '}
        </Text>
        {/* Read is served by the ui.press hook above. */}
        <Button key="read" label="Read" onPress={() => undefined} />
        <Text> </Text>
        <Button
          key="reply"
          label="Reply"
          onPress={async () => {
            // Whatever the person had typed becomes the reply's text.
            const draft = (await $.prompt.read()).text.trim()
            const text = draft.startsWith('/relay-reply') ? draft : `/relay-reply ${draft}`
            await $.prompt.fill({ text: draft === '' ? '/relay-reply ' : text, mode: 'replace' })
          }}
        />
      </Box>
    )
  })
}
