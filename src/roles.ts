import type { Config } from "./config";

export const ROLES = ["orchestrator", "creative-director", "developer", "human"] as const;
export type Role = (typeof ROLES)[number];

/** Reserved pseudo-sender for system messages. No token maps to it. */
export const RELAY = "relay";
export type Actor = Role | typeof RELAY;

export const MIN_TOKEN_LENGTH = 32;

interface RoleInfo {
  displayName: string;
  tokenVar: keyof RoleTokenSecrets;
  aliases: readonly string[];
}

const ROLE_INFO: Record<Role, RoleInfo> = {
  orchestrator: { displayName: "Orchestrator", tokenVar: "ORCHESTRATOR_TOKEN", aliases: ["orch"] },
  "creative-director": {
    displayName: "Creative Director",
    tokenVar: "CREATIVE_DIRECTOR_TOKEN",
    aliases: ["cd", "creative"],
  },
  developer: {
    displayName: "Full-Stack Developer",
    tokenVar: "DEVELOPER_TOKEN",
    aliases: ["full-stack-developer", "dev"],
  },
  human: { displayName: "James", tokenVar: "HUMAN_TOKEN", aliases: ["james"] },
};

/** The three agent roles (everyone except the human). */
export function isAgent(actor: Actor): boolean {
  return actor !== "human" && actor !== RELAY;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function displayName(actor: Actor, config: Config): string {
  if (actor === RELAY) return "Relay";
  return actor === "human" ? config.humanName : ROLE_INFO[actor].displayName;
}

export function aliases(role: Role, config: Config): string[] {
  const list = [...ROLE_INFO[role].aliases];
  if (role === "human") {
    const fromName = normalize(config.humanName);
    if (fromName && fromName !== RELAY && !list.includes(fromName)) list.push(fromName);
  }
  return list;
}

/** Resolves a canonical role id, alias or display name; returns null for unknown names and `relay`. */
export function resolveRole(name: string, config: Config): Role | null {
  const key = normalize(name);
  for (const role of ROLES) {
    if (role === key || aliases(role, config).includes(key) || normalize(displayName(role, config)) === key) {
      return role;
    }
  }
  return null;
}

/** The role's token if it is configured and long enough; otherwise the role is disabled. */
export function roleToken(env: Env, role: Role): string | null {
  const token = env[ROLE_INFO[role].tokenVar];
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH ? token : null;
}

export function enabledTokens(env: Env): string[] {
  return ROLES.map((role) => roleToken(env, role)).filter((token): token is string => token !== null);
}

export interface RoleEntry {
  id: Role;
  display_name: string;
  aliases: string[];
  enabled: boolean;
}

export function roleDirectory(env: Env, config: Config): RoleEntry[] {
  return ROLES.map((id) => ({
    id,
    display_name: displayName(id, config),
    aliases: aliases(id, config),
    enabled: roleToken(env, id) !== null,
  }));
}

export function roleList(): string {
  return ROLES.map((role) => `${role} (${ROLE_INFO[role].aliases.join(", ")})`).join(", ");
}
