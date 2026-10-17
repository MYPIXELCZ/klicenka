import { supabaseKlicenka } from "@mypixel/klicenka/supabase";

export const POST = supabaseKlicenka({
  issuer: process.env.KLICENKA_ISSUER!,
  audience: "example-supabase",
  environment: "local",
  supabaseUrl: process.env.SUPABASE_URL!,
  anonKey: process.env.SUPABASE_ANON_KEY!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  redirectTo: "/admin",
});
