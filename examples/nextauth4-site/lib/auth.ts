import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { MemoryJtiStore } from "@mypixel/klicenka";
import { klicenkaJwt, klicenkaProvider, klicenkaSessionValid } from "@mypixel/klicenka/next-auth";

/** Like damsito: NextAuth v4, Pages Router, JWT sessions, own users. */
const USERS = [{ id: "1", email: "admin@example.test", name: "Admin" }];

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET ?? "example-only-nextauth-secret",
  session: { strategy: "jwt" },
  providers: [
    klicenkaProvider(CredentialsProvider as never, {
      issuer: process.env.KLICENKA_ISSUER!,
      audience: "example-nextauth4",
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
};
