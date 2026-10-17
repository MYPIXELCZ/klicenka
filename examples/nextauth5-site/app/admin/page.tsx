import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function Admin() {
  const s = (await auth()) as { user?: { email?: string }; act?: { name: string | null; email: string } } | null;
  return (
    <main>
      <h1>Administrace (NextAuth v5)</h1>
      <p id="state">{s?.user?.email ? `Přihlášen jako ${s.user.email}` : "Nepřihlášen"}</p>
      {s?.act && <p id="act">Přes Klíčenku: {s.act.name} &lt;{s.act.email}&gt;</p>}
    </main>
  );
}
