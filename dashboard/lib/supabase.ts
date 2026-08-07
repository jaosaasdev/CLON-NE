import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Clientes Supabase do painel.
 *
 * - `supabase`  → anon key (leitura no browser / painel)
 * - `supabaseAdmin` → service role se disponível; senão cai na anon key
 *   (a API /api/save-clone usa este cliente para upload + insert)
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_URL");
}

if (!supabaseAnonKey) {
  throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export const CLONES_BUCKET = "cloned-files";

export type CloneRecord = {
  id: string;
  title: string;
  original_url: string;
  storage_path: string;
  created_at: string;
};

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/** Preferencialmente service_role no servidor — bypassa RLS e evita uploads bloqueados. */
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceRoleKey || supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

export function getPublicFileUrl(storagePath: string): string {
  const { data } = supabase.storage.from(CLONES_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}
