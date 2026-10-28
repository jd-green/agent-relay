import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { readConfig } from '../hooks/relay'

const OPTIONS = { relay_url: 'https://relay.test', role_token: 'test-token-spike', poll_seconds: 15 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const TYPED = { wait: false, origin: { kind: 'composer' } } as const
const PRESENTATION = { isFullscreen: false, columns: 80 }
const PROJECT_TEXT = 'Project "Agent Relay: developer" instructions: you are the developer role.'

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
  const session = { id: 'sess-1', cwd: '/work/project-a' }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: session.cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: '2.1.312', base: '2.1.312', builtAt: '2026-10-01T00:00:00Z' } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: 'engine' }))
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))
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
  const posts = () => relay.requests.filter(request => request.method === 'POST').length
  const wakePolls = () => relay.requests.filter(request => request.url.includes('/spike/wake')).length
  return { relay, session, clock, posts, wakePolls }
}

const names = (events: Posted[]) => events.map(event => event.event)

/** The hex SHA-256 of `text`, as the test computes it for itself. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

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

test('the marker nonce follows the session id, not the load', { options: OPTIONS }, async ($, on) => {
  const { relay, session, clock } = engine(on)
  const expected = (await sha256('relay-spike marker:sess-1')).slice(0, 8)

  await $.session.start(START)
  const first = await $.prompt.submit({ ...TYPED, text: 'one' })
  // The session starts again in the same load (as after a reload): the nonce stands.
  await $.session.start(START)
  const second = await $.prompt.submit({ ...TYPED, text: 'two' })
  // A new conversation (/clear) is a new session id, so a new nonce.
  session.id = 'sess-2'
  const third = await $.prompt.submit({ ...TYPED, text: 'three' })
  await clock.advance(5_000)

  expect(first.context).toEqual([expect.stringContaining(`relay-spike marker: ${expected}.`)])
  expect(second.context).toEqual(first.context)
  expect(third.context).not.toEqual(first.context)
  const starts = relay.events.filter(event => event.event === 'session.start').map(event => event.detail?.nonce)
  expect(starts).toEqual([expected, expected])
  const injected = relay.events.filter(event => event.event === 'context.injected').map(event => event.detail?.nonce)
  expect(injected).toEqual([expected, expected, (await sha256('relay-spike marker:sess-2')).slice(0, 8)])
})

test('prompt.context: block names and fingerprints of the attached Project and the directory, never their text', { options: OPTIONS }, async ($, on) => {
  const { relay, session, clock } = engine(on)
  await $.session.start(START)

  await $.prompt.context({
    blocks: [
      { name: 'claudeMd', text: 'Always answer in French.' },
      { name: 'attachedProject', text: PROJECT_TEXT },
      { name: 'currentDate', text: "Today's date is 2026-10-28." },
    ],
  })
  await $.prompt.context({ blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-28." }] })
  await clock.advance(5_000)

  const records = relay.events.filter(event => event.event === 'prompt.context').map(event => event.detail)
  const cwd = { sha256: (await sha256(session.cwd)).slice(0, 16), length: session.cwd.length }
  expect(records).toEqual([
    {
      blocks: ['claudeMd', 'attachedProject', 'currentDate'],
      attached_project: { sha256: (await sha256(PROJECT_TEXT)).slice(0, 16), length: PROJECT_TEXT.length },
      cwd,
    },
    { blocks: ['currentDate'], attached_project: null, cwd },
  ])
  expect(relay.events.find(event => event.event === 'session.start')?.detail?.cwd).toEqual(cwd)
  const raw = JSON.stringify(relay.events)
  for (const text of ['French', 'Agent Relay: developer', 'project-a', '2026-10-28.']) expect(raw).not.toContain(text)
})

test('a relay that is down never breaks a hook, and records are retried with backoff', { options: OPTIONS }, async ($, on) => {
  const { relay, clock, posts } = engine(on)
  relay.isDown = true

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

test('at exit, a relay that just failed is not asked again', { options: OPTIONS }, async ($, on) => {
  const { relay, clock, posts } = engine(on)
  await $.session.start(START)
  await clock.settle()
  const before = posts()

  relay.isDown = true
  await $.prompt.submit({ ...TYPED, text: 'one more record' })
  await clock.advance(5_000)
  expect(posts()).toBe(before + 1)
  const asked = relay.requests.length
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(relay.requests).toHaveLength(asked)
})

test('at exit, the last records are posted while the relay answers', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  await $.session.start(START)
  await clock.settle()

  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(names(relay.events)).toContain('session.end')
})

test('a wake starts a turn while idle; one that comes during a turn is deferred, then submitted once idle', { options: OPTIONS }, async ($, on) => {
  const { relay, clock } = engine(on)
  relay.wakes.push({ id: 'W1', text: 'Reply with the word awake.' })

  await $.session.start(START)
  await clock.settle()
  expect(relay.requests.some(request => request.url === 'https://relay.test/spike/wake?session_id=sess-1')).toBe(true)
  expect(relay.submitted).toEqual([{ text: 'Reply with the word awake.', origin: 'plugin' }])

  await $.turn.start({ text: '', turnId: 't1' })
  relay.wakes.push({ id: 'W2', text: 'Second wake.' }, { id: 'W3', text: 'Third wake.' })
  await clock.advance(15_000)
  expect(relay.submitted).toHaveLength(1)

  // Idle again: the oldest deferred wake goes, the next once its turn is over.
  await clock.advance(5_000)
  await $.turn.complete({ answer: 'awake', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(relay.submitted.map(prompt => prompt.text)).toEqual(['Reply with the word awake.', 'Second wake.'])
  await $.turn.start({ text: 'Second wake.', turnId: 't2' })
  await clock.advance(5_000)
  expect(relay.submitted).toHaveLength(2)
  await $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(relay.submitted.map(prompt => prompt.text)).toEqual(['Reply with the word awake.', 'Second wake.', 'Third wake.'])
  await clock.advance(5_000)

  const wakeEvents = relay.events.filter(event => event.event.startsWith('wake.'))
  expect(wakeEvents.map(event => [event.event, event.detail?.wake_id])).toEqual([
    ['wake.submitted', 'W1'],
    ['wake.turn_started', 'W1'],
    ['wake.deferred', 'W2'],
    ['wake.deferred', 'W3'],
    ['wake.submitted', 'W2'],
    ['wake.turn_started', 'W2'],
    ['wake.submitted', 'W3'],
    ['wake.turn_started', 'W3'],
  ])
  expect(wakeEvents.find(event => event.event === 'wake.submitted' && event.detail?.wake_id === 'W2')?.detail).toMatchObject({
    deferred_s: 5,
  })
})

test('wake polls run every poll_seconds exactly', { options: OPTIONS }, async ($, on) => {
  const { clock, wakePolls } = engine(on)
  await $.session.start(START)
  await clock.settle()
  expect(wakePolls()).toBe(1)

  await clock.advance(15_000)
  expect(wakePolls()).toBe(2)
  await clock.advance(14_000)
  expect(wakePolls()).toBe(2)
  await clock.advance(1_000)
  expect(wakePolls()).toBe(3)
})

test('/relay-spike shows counts, token state and reachability', { options: OPTIONS }, async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.md' })
  await clock.advance(5_000)

  const shown = await $.command.run({ command: 'relay-spike', args: '', origin: TYPED.origin, presentation: PRESENTATION })

  expect(shown.text).toContain(`relay-spike · marker nonce ${(await sha256('relay-spike marker:sess-1')).slice(0, 8)}`)
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

test('heartbeats are exempt from the cap: an idle night keeps reporting', { options: OPTIONS, timeoutMs: 60_000 }, async ($, on) => {
  const { relay, clock } = engine(on)
  await $.session.start(START)
  // 60 heartbeats, five minutes apart: past the cap of 50 that other events have.
  for (let beat = 0; beat < 60; beat += 1) await clock.advance(5 * 60_000)

  expect(names(relay.events).filter(name => name === 'spike.heartbeat').length).toBeGreaterThan(60)
})

test('relay_url: https anywhere, plain http only to this machine', () => {
  const read = (relay_url: string) => readConfig('relay-spike', { relay_url, role_token: 't', poll_seconds: 30 }, 30)
  expect(read('https://agent-relay.example.workers.dev').url).toBe('https://agent-relay.example.workers.dev')
  expect(read('http://127.0.0.1:8787/').url).toBe('http://127.0.0.1:8787')
  expect(read('http://localhost:8787').url).toBe('http://localhost:8787')
  expect(() => read('http://agent-relay.example.workers.dev')).toThrow('relay_url must be https')
})

test('a plain http relay_url on another host fails the load: no request carries the token', { options: { ...OPTIONS, relay_url: 'http://relay.test' } }, async ($, on) => {
  const { relay } = engine(on)
  let failure = ''
  try {
    await $.session.start(START)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  expect(failure).toContain('relay-spike: hooks module did not load: relay_url must be https')
  expect(relay.requests).toEqual([])
})
