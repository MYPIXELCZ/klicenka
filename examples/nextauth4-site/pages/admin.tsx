import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../lib/auth";

type Props = { email: string | null; act: { name: string | null; email: string } | null };

export const getServerSideProps: GetServerSideProps<Props> = async ({ req, res }) => {
  const s = (await getServerSession(req, res, authOptions)) as { user?: { email?: string }; act?: Props["act"] } | null;
  return { props: { email: s?.user?.email ?? null, act: s?.act ?? null } };
};

export default function Admin({ email, act }: Props) {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Administrace (NextAuth v4)</h1>
      <p id="state">{email ? `Přihlášen jako ${email}` : "Nepřihlášen"}</p>
      {act && <p id="act">Přes Klíčenku: {act.name} &lt;{act.email}&gt;</p>}
    </main>
  );
}
