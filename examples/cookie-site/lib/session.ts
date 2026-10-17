import { SignJWT, jwtVerify } from "jose";

/** A site with its own cookie session (jose), like kozi-pelisek or barvypp. */
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET ?? "example-only-session-secret-not-for-production");
export const COOKIE = "example_session";

export const USERS = [
  { id: 1, email: "admin@example.test", name: "Admin", role: "admin" },
  { id: 2, email: "editor@example.test", name: "Editor", role: "editor" },
];

export async function createSession(user: (typeof USERS)[number], maxAgeSeconds: number, act?: { name: string | null; email: string }) {
  return new SignJWT({ email: user.email, role: user.role, act })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setExpirationTime(`${maxAgeSeconds}s`)
    .sign(SECRET);
}

export async function readSession(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as { sub: string; email: string; role: string; act?: { name: string | null; email: string } };
  } catch {
    return null;
  }
}
