import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const dynamic = "force-dynamic";

export default async function Admin() {
  const store = await cookies();
  const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: () => {} },
  });
  const { data } = await supabase.auth.getUser();
  const until = store.get("klicenka_until")?.value;
  return (
    <main>
      <h1>Administrace (Supabase Auth)</h1>
      <p id="state">{data.user ? `Přihlášen jako ${data.user.email}` : "Nepřihlášen"}</p>
      {until && <p id="until">Přihlášení přes Klíčenku platí do {new Date(Number(until)).toLocaleString("cs-CZ")}</p>}
    </main>
  );
}
