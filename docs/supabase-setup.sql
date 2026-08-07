-- =============================================================================
-- Web Cloner Dashboard — schema Supabase
-- Projeto: clon-ne (gzeacecuhttwcufeffxz)
--
-- Já aplicado via MCP. Use este arquivo se precisar recriar em outro projeto:
-- SQL Editor → New query → colar e Run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.clones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  original_url text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clones_created_at_idx
  ON public.clones (created_at DESC);

ALTER TABLE public.clones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read clones" ON public.clones;
CREATE POLICY "Public can read clones"
  ON public.clones
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "API can insert clones" ON public.clones;
CREATE POLICY "API can insert clones"
  ON public.clones
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Bucket público para os ZIPs (limite 50 MB)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cloned-files',
  'cloned-files',
  true,
  52428800,
  ARRAY['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public can read cloned files" ON storage.objects;
CREATE POLICY "Public can read cloned files"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'cloned-files');

DROP POLICY IF EXISTS "API can upload cloned files" ON storage.objects;
CREATE POLICY "API can upload cloned files"
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'cloned-files');

DROP POLICY IF EXISTS "Service role can manage cloned files" ON storage.objects;
CREATE POLICY "Service role can manage cloned files"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'cloned-files')
  WITH CHECK (bucket_id = 'cloned-files');
