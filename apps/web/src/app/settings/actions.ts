"use server";

import { randomBytes, createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export interface RotateResult {
  token?: string;
  org?: string;
  error?: string;
}

/**
 * Mint a fresh ingest token for an installation. The raw token is returned
 * exactly once for the caller to copy — only its SHA-256 hash is stored.
 */
export async function rotateToken(_prev: RotateResult, formData: FormData): Promise<RotateResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "bad installation id" };

  const token = randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const res = await db().execute(
    sql`update installation set ingest_token_hash = ${hash} where id = ${id} returning org`,
  );
  const org = (res.rows[0] as { org?: string } | undefined)?.org;
  if (!org) return { error: "installation not found" };
  revalidatePath("/settings");
  return { token, org };
}
