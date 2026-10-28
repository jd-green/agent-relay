/** A message as the relay's inbox tool returns it (docs/DESIGN.md section 6). */
export type RelayMessage = {
  id: string
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
}

export type RelayBuild = { build_id: string; title: string; status: string }

/** Whether the last poll reached the relay; drawn in the status line. */
export type RelayHealth =
  | { kind: 'starting' }
  | { kind: 'ok' }
  | { kind: 'unauthorized' }
  | { kind: 'failing'; message: string; retryAt: number }

/** What the band and the status line draw from: the last peek, less what was handed over since. */
export type RelayInbox = {
  /** The role the token belongs to, once the relay has answered. */
  role: string | null
  /** Messages unread on the relay as of the last peek, oldest first. */
  unread: RelayMessage[]
  builds: RelayBuild[]
  /** The global kill switch's reason while it is on. */
  halted: string | null
  health: RelayHealth
}

/** Bookkeeping that must survive a reload so no batch wakes the session twice. */
export type RelayMemory = {
  /** `<build_id>/<id>` of every message that already triggered a wake (newest 500). */
  woken: string[]
  /** The newest messages handed to the model, oldest first; /relay shows them and /relay-reply answers the last. */
  recent: RelayMessage[]
  /** Engine-clock time of the last wake, 0 for never. */
  lastWakeAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'relay-inbox': { inbox: Shaped<RelayInbox>; memory: Shaped<RelayMemory> }
  }
}
