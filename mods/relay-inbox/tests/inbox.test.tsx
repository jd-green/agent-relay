import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { relay_url: 'https://relay.test', role_token: 'test-token-developer', poll_seconds: 60 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const TYPED = { wait: false, origin: { kind: 'composer' } } as const
const PRESENTATION = { isFullscreen: false, columns: 80 }
const BUILD = 'b-test000001'
const BAND = {
  plugin: 'relay-inbox',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const
const wake = (count: number) =>
  `[relay] ${count} new relay message(s) for build ${BUILD}. Check your relay inbox and act per the relay protocol.`

type Message = {
  id: string
  seq: number
  build_id: string
  from: string
  to: string
  type: string
  task_id: string | null
  body: string
  links: { url: string; label?: string }[]
  verdict: string | null
  changes: string[] | null
  reply_to: string | null
  on_behalf_of: string | null
  created_at: string
  read_at: string | null
}

function message(seq: number, fields: Partial<Message> = {}): Message {
  return {
    id: `M${seq}`,
    seq,
    build_id: BUILD,
    from: 'creative-director',
    to: 'developer',
    type: 'review_request',
    task_id: 'T2',
    body: `Body of message ${seq}.`,
    links: [],
    verdict: null,
    changes: null,
    reply_to: null,
    on_behalf_of: null,
    created_at: `2026-10-28T12:00:${String(seq).padStart(2, '0')}.000Z`,
    read_at: null,
    ...fields,
  }
}

/** The engine beneath the plugin, with an in-memory relay answering `$.http.fetch`. */
function engine(on: On) {
  const relay = {
    messages: [] as Message[],
    halted: null as string | null,
    buildStatus: 'in_progress',
    answer: 'ok' as 'ok' | 'down' | 'unauthorized',
    requests: [] as { method: string; path: string; query: string; body?: unknown; authorization?: string }[],
    sent: [] as unknown[],
  }
  const seen = {
    statuses: [] as string[],
    submitted: [] as { text: string; origin: string; context?: readonly string[] }[],
    filled: [] as string[],
    draft: '',
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    if (e.text !== undefined) seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: seen.draft.length } }))
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push({ text: e.text, origin: e.origin.kind, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    relay.requests.push({ method, path: url.pathname, query: url.search, body, authorization: e.init?.headers?.authorization })
    const answer = (status: number, envelope: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(envelope) },
    })
    if (relay.answer === 'down') return answer(503, { ok: false, error: { code: 'unavailable', message: 'down' } })
    if (relay.answer === 'unauthorized') return answer(401, { ok: false, error: { code: 'unauthorized', message: 'unknown token' } })
    const inbox = (markRead: boolean) => {
      const unread = relay.messages.filter(one => one.read_at === null)
      if (markRead) for (const one of unread) one.read_at = '2026-10-28T13:00:00.000Z'
      return answer(200, {
        ok: true,
        result: {
          role: 'developer',
          halted: { global: relay.halted !== null, reason: relay.halted, at: null },
          builds: [{ build_id: BUILD, title: 'Habit tracker', status: relay.buildStatus, messages: unread, unread_remaining: 0 }],
        },
      })
    }
    if (url.pathname === '/api/inbox' && method === 'GET') return inbox(false)
    if (url.pathname === '/api/call/inbox' && method === 'POST') return inbox(body?.peek === false)
    if (url.pathname === '/api/call/send' && method === 'POST') {
      relay.sent.push(body)
      return answer(200, { ok: true, result: { message: { id: 'M9' } } })
    }
    return answer(404, { ok: false, error: { code: 'not_found', message: 'no route' } })
  })
  // Nothing beneath the plugin draws the band: this hook stands for the engine.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { relay, seen, clock }
}

const relayCommand = (command: string, args = '') => ({ command, args, origin: TYPED.origin, presentation: PRESENTATION })

test('polls at start: unread count in the status line and the band on every surface that has one', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1, { from: 'orchestrator', type: 'handoff', task_id: 'T1' }), message(2))

  await $.session.start(START)
  await clock.settle()

  expect(relay.requests[0]).toMatchObject({
    method: 'GET',
    path: '/api/inbox',
    query: '?peek=1&limit=100&session_ref=sess-1',
    authorization: 'Bearer test-token-developer',
  })
  expect(seen.statuses.at(-1)).toBe(`Relay · 2 unread · ${BUILD} in_progress`)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Relay/ }))?.text).toBe(
      'Relay · 2 unread · creative-director → review_request (T2) ',
    )
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['read', 'reply'])
    await ui.unmount()
  }
})

test('draws nothing above the prompt when nothing is unread', { options: OPTIONS }, async ($, on) => {
  const { seen, clock } = engine(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  expect(seen.statuses.at(-1)).toBe(`Relay · 0 unread · ${BUILD} in_progress`)
})

test('hands unread messages to the next prompt once, then marks them read', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(
    message(1, {
      type: 'verdict',
      verdict: 'changes_requested',
      changes: ['Raise the contrast of the primary button', 'Use the 8px grid'],
      links: [{ url: 'https://preview.test/1', label: 'Preview' }],
      reply_to: 'M0',
      body: 'Two fixes, then it ships.',
    }),
  )
  await $.session.start(START)
  await clock.settle()

  const first = await $.prompt.submit({ ...TYPED, text: 'carry on' })
  const context = first.context?.[0] ?? ''
  expect(context).toContain(`[M1] build ${BUILD} "Habit tracker" · from creative-director → verdict · task T2 · verdict changes_requested · reply to M0`)
  expect(context).toContain('changes:\n1. Raise the contrast of the primary button\n2. Use the 8px grid')
  expect(context).toContain('links: Preview <https://preview.test/1>')
  expect(context).toContain('body:\nTwo fixes, then it ships.')

  await clock.settle()
  expect(relay.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/call/inbox', body: { peek: false, session_ref: 'sess-1' } })
  expect(relay.messages[0]?.read_at).not.toBeNull()
  expect(seen.statuses.at(-1)).toBe(`Relay · 0 unread · ${BUILD} in_progress`)

  const second = await $.prompt.submit({ ...TYPED, text: 'next' })
  expect(second.context).toBeUndefined()
})

test('the first prompt carries what the start of the session found', { options: OPTIONS }, async ($, on) => {
  const { relay } = engine(on)
  relay.messages.push(message(1))

  await $.session.start(START)
  const first = await $.prompt.submit({ ...TYPED, text: 'first' })

  expect(first.context?.[0]).toContain('[M1] build')
})

test('what a run was given is marked read on the way out, even after a failed try', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.messages.push(message(1))
  await $.session.start(START)

  relay.answer = 'down'
  await $.prompt.submit({ ...TYPED, text: 'one turn' })
  await clock.settle()
  expect(relay.messages[0]?.read_at).toBeNull()

  relay.answer = 'ok'
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(relay.messages[0]?.read_at).not.toBeNull()
})

test('a message that arrives between the peek and the mark-read reaches the following prompt', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.messages.push(message(1))
  await $.session.start(START)
  await clock.settle()

  relay.messages.push(message(2, { type: 'question', task_id: null }))
  const first = await $.prompt.submit({ ...TYPED, text: 'one' })
  await clock.settle()
  expect(first.context?.[0]).toContain('[M1]')
  expect(first.context?.[0]).not.toContain('[M2]')
  expect(relay.messages.every(one => one.read_at !== null)).toBe(true)

  const second = await $.prompt.submit({ ...TYPED, text: 'two' })
  expect(second.context?.[0]).toContain('[M2] build')
  expect(second.context?.[0]).not.toContain('[M1]')
})

test('auto-wake: once per new batch, never mid-turn, at least 120 s apart', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1))
  await $.session.start(START)
  await clock.settle()

  const wakes = () => seen.submitted.filter(prompt => prompt.origin === 'plugin').map(prompt => prompt.text)
  // Not in the first seconds: a prompt already on its way goes first.
  expect(wakes()).toEqual([])
  await clock.advance(10_000)
  expect(wakes()).toEqual([wake(1)])

  // A new batch, but within 120 s of the last wake.
  relay.messages.push(message(2))
  await clock.advance(60_000)
  expect(wakes()).toHaveLength(1)

  // The gap has passed, but a turn is running.
  await $.turn.start({ text: '', turnId: 't1' })
  await clock.advance(60_000)
  expect(wakes()).toHaveLength(1)

  // M1 is still unread: the wake asked the model to read it with the relay's inbox tool.
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(wakes()).toEqual([wake(1), wake(2)])

  // Nothing new since: no more wakes.
  await clock.advance(180_000)
  expect(wakes()).toHaveLength(2)
})

test('no wake while the relay reports the kill switch on', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1))
  relay.halted = 'runaway loop'
  await $.session.start(START)
  await clock.advance(120_000)

  expect(seen.submitted).toHaveLength(0)
  expect(seen.statuses.at(-1)).toBe('Relay · halted: runaway loop · 1 unread')
})

test('no wake for a build the human halted', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1, { from: 'relay', on_behalf_of: null, type: 'status', task_id: null }))
  relay.buildStatus = 'halted'
  await $.session.start(START)
  await clock.advance(120_000)

  expect(seen.submitted).toHaveLength(0)
})

test('no wake when auto_wake is off, but the band still shows', { options: { ...OPTIONS, auto_wake: false } }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1))
  await $.session.start(START)
  await clock.advance(120_000)

  expect(seen.submitted).toHaveLength(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Relay/ }))?.text).toContain('Relay · 1 unread')
  await ui.unmount()
})

test('an unreachable relay shows in the status line and backs off; prompts still go through', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.answer = 'down'
  await $.session.start(START)
  await clock.settle()
  const polls = () => relay.requests.filter(request => request.path === '/api/inbox').length

  expect(seen.statuses.at(-1)).toBe('Relay · unreachable (unavailable: down), retrying in 2m · 0 unread')
  expect((await $.prompt.submit({ ...TYPED, text: 'works' })).text).toBe('works')
  await clock.advance(60_000)
  expect(polls()).toBe(1)
  await clock.advance(60_000)
  expect(polls()).toBe(2)

  relay.answer = 'ok'
  relay.messages.push(message(1))
  await clock.advance(240_000)
  expect(seen.statuses.at(-1)).toBe(`Relay · 1 unread · ${BUILD} in_progress`)
  expect(seen.submitted.filter(prompt => prompt.origin === 'plugin').map(prompt => prompt.text)).toEqual([wake(1)])
})

test('a rejected token says so in the status line', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.answer = 'unauthorized'
  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses.at(-1)).toBe('Relay · token rejected (401): check role_token')
})

test('/relay lists unread and earlier messages, marks them read, and gives the model the new ones', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.messages.push(
    message(1, { links: [{ url: 'https://preview.test/1', label: 'Preview' }] }),
    message(2, { type: 'verdict', verdict: 'changes_requested', changes: ['Use the 8px grid'] }),
  )
  await $.session.start({ ...START, isInteractive: true })
  await clock.settle()

  const shown = await $.command.run(relayCommand('relay'))
  expect(shown.text).toContain('Relay · developer · 2 unread, now marked read')
  expect(shown.text).toContain(`M1  ${BUILD}  creative-director → review_request (T2)`)
  expect(shown.text).toContain('Preview: https://preview.test/1')
  expect(shown.text).toContain(`M2  ${BUILD}  creative-director → verdict (T2) · changes_requested`)
  expect(shown.text).toContain('    1. Use the 8px grid')
  expect(shown.context?.[0]).toContain('[M2] build')
  expect(relay.messages.every(one => one.read_at !== null)).toBe(true)

  const again = await $.command.run(relayCommand('relay'))
  expect(again.text).toContain('Relay · developer · 0 unread')
  expect(again.text).toContain('Earlier:')
  expect(again.context).toBeUndefined()
})

test('/relay-reply sends a status to the sender of the newest message', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.messages.push(message(1, { from: 'orchestrator', type: 'task', task_id: 'T1' }), message(2))
  await $.session.start(START)
  await clock.settle()

  expect((await $.command.run(relayCommand('relay-reply'))).text).toBe(
    `Usage: /relay-reply <text> (replies to creative-director's M2 in ${BUILD})`,
  )
  const sent = await $.command.run(relayCommand('relay-reply', 'Fixed in the latest preview'))
  expect(sent.text).toBe(`Sent M9 to creative-director (reply to M2, build ${BUILD}).`)
  expect(relay.sent).toEqual([
    { build_id: BUILD, to_role: 'creative-director', type: 'status', body: 'Fixed in the latest preview', reply_to: 'M2' },
  ])
})

test('a reply to a relay nudge goes to the role it speaks for', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.messages.push(message(1, { from: 'relay', on_behalf_of: 'orchestrator', type: 'status', task_id: 'T2' }))
  await $.session.start(START)
  await clock.settle()

  await $.command.run(relayCommand('relay-reply', 'On it'))
  expect(relay.sent).toEqual([{ build_id: BUILD, to_role: 'orchestrator', type: 'status', body: 'On it', reply_to: 'M1' }])
})

test('the band: Read runs /relay, Reply pre-fills the prompt', { options: OPTIONS }, async ($, on) => {
  const { relay, seen, clock } = engine(on)
  relay.messages.push(message(1))
  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    seen.draft = ''
    await ui.press({ key: 'reply' })
    seen.draft = 'looks good'
    await ui.press({ key: 'reply' })
    await ui.unmount()
  }
  expect(seen.filled).toEqual(['/relay-reply ', '/relay-reply looks good', '/relay-reply ', '/relay-reply looks good'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'read' })
  await clock.settle()
  expect(relay.requests.some(request => request.path === '/api/call/inbox')).toBe(true)
  expect(relay.messages[0]?.read_at).not.toBeNull()
  await ui.unmount()
})
