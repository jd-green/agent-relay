import { ROLES, roleToken, type Role } from "./roles";

const encoder = new TextEncoder();

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * Maps a presented token to its role. Both sides are hashed and compared in
 * constant time, and every enabled role is checked so timing does not reveal
 * which role matched.
 */
export async function authenticate(env: Env, token: string | null): Promise<Role | null> {
  if (!token) return null;
  const presented = await sha256(token);
  let match: Role | null = null;
  for (const role of ROLES) {
    const secret = roleToken(env, role);
    if (secret === null) continue;
    const expected = await sha256(secret);
    if (crypto.subtle.timingSafeEqual(presented, expected) && match === null) match = role;
  }
  return match;
}
