import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { MemoryJtiStore } from "@mypixel/klicenka";
import { klicenkaJwt, klicenkaProvider, klicenkaSessionValid } from "@mypixel/klicenka/next-auth";

/** Like zvladneme: NextAuth v5 (Auth.js), App Router, JWT sessions. */
const USERS = [{ id: "1", email: "admin@example.test", name: "Admin" }];

export const { handlers, auth } = NextAuth({
  secret: process.env.AUTH_SECRET ?? "example-only-auth-secret-0123456789",
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    klicenkaProvider(Credentials as never, {
      issuer: process.env.KLICENKA_ISSUER!,
      audience: "example-nextauth5",
      environment: "local",
      jtiStore: new MemoryJtiStore(), // example only — a real site uses its database
      findUser: async (sub) => USERS.find((u) => u.email === sub) ?? null,
    }) as never,
  ],
  callbacks: {
    jwt: ({ token, user }) => klicenkaJwt(token, user),
    session: ({ session, token }) => {
      if (!klicenkaSessionValid(token)) return { ...session, user: undefined, expired: true } as never;
      return { ...session, act: token.klicenkaAct } as never;
    },
  },
});
