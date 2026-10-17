import { cookies } from "next/headers";
import { COOKIE, readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Admin() {
  const s = await readSession((await cookies()).get(COOKIE)?.value);
  if (!s) return <main><h1>Administrace</h1><p id="state">Nepřihlášen</p></main>;
  return (
    <main>
      <h1>Administrace</h1>
      <p id="state">Přihlášen jako {s.email} ({s.role})</p>
      {s.act && <p id="act">Přes Klíčenku: {s.act.name} &lt;{s.act.email}&gt;</p>}
    </main>
  );
}
