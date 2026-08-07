import { NextRequest, NextResponse } from "next/server";
import { CLONES_BUCKET, supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // alinhado ao bucket e ao next.config

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Clone-Secret",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function slugifyHost(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return host.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 40) || "site";
  } catch {
    return "site";
  }
}

function assertApiSecret(request: NextRequest): string | null {
  const expected = process.env.CLONE_API_SECRET;
  if (!expected) return null; // secreto opcional em ambiente local

  const provided =
    request.headers.get("x-clone-secret") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!provided || provided !== expected) {
    return "Unauthorized: missing or invalid X-Clone-Secret.";
  }
  return null;
}

/**
 * POST /api/save-clone
 * FormData esperado da extensão: title, url, file (.zip)
 *
 * Ordem crítica (anti-órfãos):
 *  1) valida payload
 *  2) upload no Storage
 *  3) só então INSERT na tabela clones
 *  4) se o INSERT falhar, remove o arquivo do Storage
 */
export async function POST(request: NextRequest) {
  try {
    const authError = assertApiSecret(request);
    if (authError) return json({ success: false, error: authError }, 401);

    const formData = await request.formData();
    const title = String(formData.get("title") || "").trim();
    const url = String(formData.get("url") || "").trim();
    const file = formData.get("file");

    if (!title || !url) {
      return json({ success: false, error: "Campos obrigatórios: title e url." }, 400);
    }

    if (!(file instanceof File)) {
      return json({ success: false, error: "Campo file (.zip) é obrigatório." }, 400);
    }

    if (file.size <= 0) {
      return json({ success: false, error: "O arquivo .zip está vazio." }, 400);
    }

    if (file.size > MAX_ZIP_BYTES) {
      return json(
        {
          success: false,
          error: `Arquivo muito grande (${(file.size / (1024 * 1024)).toFixed(1)} MB). Limite: 50 MB.`,
        },
        413,
      );
    }

    const mime = (file.type || "").toLowerCase();
    const looksLikeZip =
      mime.includes("zip") ||
      mime === "application/octet-stream" ||
      mime === "" ||
      file.name.toLowerCase().endsWith(".zip");

    if (!looksLikeZip) {
      return json({ success: false, error: "O arquivo deve ser um .zip." }, 400);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const storagePath = `${stamp}-${slugifyHost(url)}.zip`;
    const bytes = Buffer.from(await file.arrayBuffer());

    // 1) Storage primeiro — se falhar, NÃO grava no banco.
    const { error: uploadError } = await supabaseAdmin.storage
      .from(CLONES_BUCKET)
      .upload(storagePath, bytes, {
        contentType: "application/zip",
        upsert: false,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("[save-clone] storage upload failed:", uploadError);
      return json(
        { success: false, error: `Falha no upload: ${uploadError.message}` },
        502,
      );
    }

    // 2) Só depois do upload bem-sucedido: registro no Postgres.
    const { data: row, error: insertError } = await supabaseAdmin
      .from("clones")
      .insert({
        title,
        original_url: url,
        storage_path: storagePath,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[save-clone] db insert failed, rolling back storage:", insertError);
      // Evita arquivo órfão no bucket quando o INSERT falha.
      await supabaseAdmin.storage.from(CLONES_BUCKET).remove([storagePath]);
      return json(
        { success: false, error: `Falha ao salvar metadados: ${insertError.message}` },
        502,
      );
    }

    return json({
      success: true,
      id: row.id,
      storage_path: storagePath,
    });
  } catch (error) {
    console.error("[save-clone] unexpected error:", error);
    const message = error instanceof Error ? error.message : "Erro inesperado.";

    // Corpo truncado pelo proxy do Next → formData() pode falhar de forma obscura.
    if (/body|formdata|unexpected end|network/i.test(message)) {
      return json(
        {
          success: false,
          error:
            "Não foi possível ler o corpo da requisição. Verifique se o ZIP está abaixo de 50 MB.",
        },
        413,
      );
    }

    return json({ success: false, error: message }, 500);
  }
}
