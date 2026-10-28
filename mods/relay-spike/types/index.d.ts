/** A wake request from `GET /spike/wake`, as the spike keeps it until it is submitted. */
export type SpikeWake = {
  id: string
  text: string
  /** Engine-clock time it was put off because a turn was running. */
  deferredAt: number
}

declare module 'claude-code' {
  interface PluginState {
    /** Wakes that came while a turn ran, oldest first: each is submitted once the session is idle again. */
    'relay-spike': { deferred: Shaped<SpikeWake[]> }
  }
}
