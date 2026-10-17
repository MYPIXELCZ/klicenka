import { MemoryJtiStore, redirectWithCookie } from "@mypixel/klicenka";
import { klicenkaLogin } from "@mypixel/klicenka/next";
import { COOKIE, USERS, createSession } from "@/lib/session";

// Example only: a real site keeps used token ids in its database (createJtiStore).
const jtiStore = new MemoryJtiStore();

export const POST = klicenkaLogin({
  issuer: process.env.KLICENKA_ISSUER!,
  audience: process.env.KLICENKA_AUDIENCE ?? "example-cookie",
  environment: "local",
  jtiStore,
  findAccount: async (sub) => USERS.find((u) => u.email === sub) ?? null,
  startSession: async ({ user, claims, maxAgeSeconds }) =>
    redirectWithCookie("/admin", {
      name: COOKIE,
      value: await createSession(user, maxAgeSeconds, claims.act),
      maxAgeSeconds,
      secure: process.env.NODE_ENV === "production",
    }),
});
