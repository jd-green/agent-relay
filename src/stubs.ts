export function relayStub(env: Env) {
  return env.RELAY.get(env.RELAY.idFromName("global"));
}

export function buildStub(env: Env, buildId: string) {
  return env.BUILD.get(env.BUILD.idFromName(buildId));
}
