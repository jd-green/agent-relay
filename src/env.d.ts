// Role token secrets. They live in .dev.vars locally and in Wrangler secrets when
// deployed, so `wrangler types` only generates them when a .dev.vars file exists;
// the identical declarations here keep both outputs compatible. A secret may still
// be unset at runtime, which roleToken() treats as a disabled role.
interface RoleTokenSecrets {
  ORCHESTRATOR_TOKEN: string;
  CREATIVE_DIRECTOR_TOKEN: string;
  DEVELOPER_TOKEN: string;
  HUMAN_TOKEN: string;
}

interface Env extends RoleTokenSecrets {}

declare namespace Cloudflare {
  interface Env extends RoleTokenSecrets {}
}
