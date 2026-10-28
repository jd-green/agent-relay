import { atom, read, update } from 'claude-code'
import type { On, Register, Timer } from 'claude-code'

import type { RelayInbox, RelayMemory } from '../types'
import { Inbox, type InboxHost } from './inbox'
import { bandLine, formatForModel } from './messages'
import { type RelayConfig, errorText, readConfig } from './relay'

/** How often the mod's wake check runs (the start's grace ending, a wake whose turn never started). */
const TICK_MS = 5_000

const EMPTY_INBOX: RelayInbox = { role: null, unread: [], builds: [], halted: null, health: { kind: 'starting' } }
const EMPTY_MEMORY: RelayMemory = { woken: [], recent: [], lastWakeAt: 0 }
// Change a tag when that value's fields change: it declines what an earlier version stored.
const inboxState = atom({ plugin: 'relay-inbox', key: 'inbox' } as const, EMPTY_INBOX, { shape: 'inbox-1' })
const memoryState = atom({ plugin: 'relay-inbox', key: 'memory' } as const, EMPTY_MEMORY, { shape: 'memory-2' })

export const register: Register = (on, options) => {
  // Like a missing required field, an unusable value fails the load with a reason the person sees.
  registerInbox(on, readConfig('relay-inbox', options, 60), options.auto_wake !== false)
}

function registerInbox(on: On, config: RelayConfig, autoWake: boolean): void {
  const inbox = new Inbox(config, autoWake)
  // The engine calls of the session.start hook, which the timers and later hooks reuse.
  let host: InboxHost | undefined
  let loops: Timer[] = []

  on('session.start', async ($, e, next) => {
    const engine: InboxHost = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, options) => $.clock.sleep(ms, options),
      now: () => $.clock.now(),
      sessionId: () => $.session.id(),
      submit: text => $.prompt.submit({ text }),
      append: async text => {
        try {
          const row = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
          return row.deny === undefined
        } catch {
          return false
        }
      },
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
    } catch (error) {
      $.ui.log(`relay-inbox: ${errorText(error)}`, { to: 'debug' })
    }
    for (const loop of loops) loop.cancel()
    loops = [
      // Polls exactly every poll_seconds; the beat skips while a failing relay backs off.
      $.clock.every(config.pollMs, () => inbox.background(engine, () => inbox.beat(engine))),
      $.clock.every(TICK_MS, () => inbox.background(engine, () => inbox.maybeWake(engine))),
    ]
    // Not awaited: the first prompt makes its own read, so the session starts at once.
    inbox.background(engine, () => inbox.beat(engine))
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

  // Unread messages ride along with a prompt that starts a turn: the prompt reads them (marking them
  // read) and carries exactly what that read returned. A slash command, or a prompt typed over a
  // running turn, carries nothing: that turn's own inbox calls cover it.
  on('prompt.submit', async ($, e, next) => {
    const engine = host
    if (e.command !== undefined || e.turnId !== undefined || engine === undefined) return next(e)
    const taken = await inbox.take(engine)
    if (taken === undefined) return next(e)
    const block = formatForModel(taken.messages, taken.builds, taken.role, taken.halted)
    const result = await next({ ...e, context: [...(e.context ?? []), block] })
    // They are read on the relay either way: a prompt that did not enter hands them over as a row.
    if (result.drop !== undefined) inbox.background(engine, () => inbox.handOver(engine, taken))
    else await inbox.delivered(engine, taken.messages)
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

  // The band above the prompt: drawn only while there are unread messages, with the halt holding them back.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, inboxState)
    if (e.props.hasSurvey || state.unread.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text wrap="truncate-end">{bandLine(state)}</Text>
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
