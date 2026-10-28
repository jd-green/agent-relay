import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { relay_url: 'https://relay.test', role_token: 'test-token-spike', poll_seconds: 15 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const TYPED = { wait: false, origin: { kind: 'composer' } } as const
const PRESENTATION = { isFullscreen: false, columns: 80 }

type Posted = { event: string; ts: string; session_id?: string; surface?: string; detail?: Record<string, unknown> }

/** The engine beneath the plugin, with an in-memory relay answering `$.http.fetch`. */
function engine(on: On) {
  const relay = {
    events: [] as Posted[],
    wakes: [] as { id: string; text: string }[],
    requests: [] as { method: string; url: string; authorization?: string }[],
    isDown: false,
    submitted: [] as { text: string; origin: string }[],
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: '2.1.312', base: '2.1.312', builtAt: '2026-10-01T00:00:00Z' } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: 'engine' }))
  on('prompt.submit', (_, e) => {
    relay.submitted.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text, context: e.context }
  })
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    relay.requests.push({ method, url: e.url, authorization: e.init?.headers?.authorization })
    const answer = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (relay.isDown) return answer(503, { ok: false, error: { code: 'unavailable', message: 'down' } })
    const url = new URL(e.url)
    if (url.pathname === '/health') return answer(200, { ok: true, name: 'agent-relay' })
    if (url.pathname === '/spike/events' && method === 'POST') {
      relay.events.push(JSON.parse(e.init?.body ?? '{}'))
      return answer(200, { ok: true, result: { event: { id: relay.events.length } } })
    }
    if (url.pathname === '/spike/wake' && method === 'GET') {
      return answer(200, { ok: true, result: { wakes: relay.wakes.splice(0) } })
    }
    return answer(404, { ok: false, error: { code: 'not_found', message: 'no route' } })
  })
  return { relay, clock }
}

const names = (events: Posted[]) => events.map(event => event.event)

test('each hook posts one record with small metadata, never the prompt text', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)

  await $.session.start(START)
  await $.prompt.submit({ ...TYPED, text: 'please read the secret plan' })
  await $.turn.start({ text: 'please read the secret plan', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'cat plan.md' })
  await $.turn.complete({ answer: 'done', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5_000)

  expect(names(relay.events)).toEqual(
    expect.arrayContaining(['session.start', 'prompt.submit', 'context.injected', 'turn.start', 'tool.call', 'turn.complete']),
  )
  const prompt = relay.events.find(event => event.event === 'prompt.submit')
  expect(prompt).toMatchObject({ session_id: 'sess-1', surface: 'terminal', detail: { origin: 'composer', text_length: 27 } })
  expect(relay.events.find(event => event.event === 'tool.call')?.detail).toEqual({ tool: 'Bash' })
  expect(relay.events.find(event => event.event === 'session.start')?.detail).toMatchObject({ entrypoint: 'cli' })
  expect(JSON.stringify(relay.events)).not.toContain('secret plan')
  expect(JSON.stringify(relay.events)).not.toContain('plan.md')
  expect(relay.requests.every(request => request.authorization === 'Bearer test-token-spike')).toBe(true)
})

test('every typed prompt carries the marker; a slash command does not', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  await $.session.start(START)

  const typed = await $.prompt.submit({ ...TYPED, text: 'hi' })
  const command = await $.prompt.submit({ ...TYPED, text: '/relay-spike', command: { name: 'relay-spike', args: '' } })
  await clock.advance(5_000)

  const nonce = relay.events.find(event => event.event === 'session.start')?.detail?.nonce
  expect(typed.context).toEqual([expect.stringContaining(`relay-spike marker: ${String(nonce)}`)])
  expect(command.context).toBeUndefined()
  expect(names(relay.events).filter(name => name === 'context.injected')).toHaveLength(1)
})

test('a relay that is down never breaks a hook, and records are retried with backoff', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.isDown = true

  const posts = () => relay.requests.filter(request => request.method === 'POST').length
  await $.session.start(START)
  await clock.settle()
  expect(posts()).toBe(1)
  const typed = await $.prompt.submit({ ...TYPED, text: 'still works' })
  expect(typed.text).toBe('still works')

  // The first failure waits 10 s, the second 20 s.
  await clock.advance(5_000)
  expect(posts()).toBe(1)
  await clock.advance(5_000)
  expect(posts()).toBe(2)
  await clock.advance(15_000)
  expect(posts()).toBe(2)

  relay.isDown = false
  await clock.advance(10_000)
  expect(names(relay.events)).toEqual(['session.start', 'spike.heartbeat', 'prompt.submit', 'context.injected'])

  const shown = await $.command.run({ command: 'relay-spike', args: '', origin: TYPED.origin, presentation: PRESENTATION })
  expect(shown.text).toContain('last error: ')
  expect(shown.text).toContain('unavailable: down')
})

test('a wake request starts a turn only while the session is idle', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.wakes.push({ id: 'W1', text: 'Reply with the word awake.' })

  await $.session.start(START)
  await clock.settle()
  expect(relay.requests.some(request => request.url === 'https://relay.test/spike/wake?session_id=sess-1')).toBe(true)
  expect(relay.submitted).toEqual([{ text: 'Reply with the word awake.', origin: 'plugin' }])

  await $.turn.start({ text: '', turnId: 't1' })
  relay.wakes.push({ id: 'W2', text: 'Second wake.' })
  await clock.advance(15_000)
  expect(relay.submitted).toHaveLength(1)

  const wakeEvents = relay.events.filter(event => event.event.startsWith('wake.'))
  expect(wakeEvents.map(event => [event.event, event.detail?.wake_id])).toEqual([
    ['wake.submitted', 'W1'],
    ['wake.turn_started', 'W1'],
    ['wake.skipped_busy', 'W2'],
  ])
})

test('/relay-spike shows counts, token state and reachability', { options: OPTIONS }, async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.md' })
  await clock.advance(5_000)

  const shown = await $.command.run({ command: 'relay-spike', args: '', origin: TYPED.origin, presentation: PRESENTATION })

  expect(shown.text).toContain('relay: reachable · token: accepted')
  expect(shown.text).toContain('  tool.call 1')
  expect(shown.text).toContain('last error: none')
})

test('a flood of one event is capped and only counted past the cap', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  await $.session.start(START)
  for (let call = 0; call < 120; call += 1) await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await clock.advance(60_000)

  expect(names(relay.events).filter(name => name === 'tool.call')).toHaveLength(50)
  const shown = await $.command.run({ command: 'relay-spike', args: '', origin: TYPED.origin, presentation: PRESENTATION })
  expect(shown.text).toContain('  tool.call 120')
})
