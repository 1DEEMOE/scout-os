/**
 * Tamper-evident job photos: SHA-256, capture time, optional GPS, uploader,
 * and a per-job hash chain. Verify view + claim-packet HTML export.
 * Edited / re-uploaded bytes are flagged; never logs photo contents.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import { jobPhotos, tasks } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, STAFF, inOrg, requireRole } from "../org/access";

const STORAGE_ROOT = process.env.WOS_JOB_PHOTO_DIR || path.join(process.cwd(), ".job-photos");

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function uploadJobPhoto(input: {
  actorUserId: string;
  orgId: string;
  jobId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  captureAt: Date;
  gpsLat?: number;
  gpsLng?: number;
}): Promise<{ photoId: string; sha256: string; chainIndex: number; integrityStatus: string }> {
  if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024) {
    throw new AppError("VALIDATION", "Photo must be between 1 byte and 20 MB");
  }
  if (!input.contentType.startsWith("image/")) throw new AppError("VALIDATION", "Only image uploads are accepted");
  return appendChainItem({ ...input, kind: "photo" });
}

/**
 * A written note in the same hash chain as the photos: hashed, timestamped
 * (server upload time plus the time it was observed), attributed, and linked
 * to the previous item, so it can't be changed or reordered unnoticed.
 */
export async function addJobNote(input: { actorUserId: string; orgId: string; jobId: string; text: string; observedAt?: Date }): Promise<{ noteId: string; sha256: string; chainIndex: number }> {
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (text.length < 2 || text.length > 5000) throw new AppError("VALIDATION", "A note is 2 to 5,000 characters");
  const r = await appendChainItem({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    jobId: input.jobId,
    filename: `note-${Date.now()}.txt`,
    contentType: NOTE_TYPE,
    bytes: Buffer.from(text, "utf8"),
    captureAt: input.observedAt ?? new Date(),
    kind: "note",
  });
  return { noteId: r.photoId, sha256: r.sha256, chainIndex: r.chainIndex };
}

export const NOTE_TYPE = "text/plain; charset=utf-8";
export const isNote = (contentType: string) => contentType.startsWith("text/plain");

async function appendChainItem(input: {
  actorUserId: string;
  orgId: string;
  jobId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  captureAt: Date;
  gpsLat?: number;
  gpsLng?: number;
  kind: "photo" | "note";
}): Promise<{ photoId: string; sha256: string; chainIndex: number; integrityStatus: string }> {
  const hash = sha256Buffer(input.bytes);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "job_photo.upload");
    const [job] = await tx.select().from(tasks).where(eq(tasks.id, input.jobId));
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    // Serialise appends per job so two uploads can't claim the same chain index.
    await tx.raw.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`job_chain:${input.jobId}`]);

    const prior = await tx
      .select()
      .from(jobPhotos)
      .where(eq(jobPhotos.jobId, input.jobId))
      .orderBy(desc(jobPhotos.chainIndex))
      .limit(1);
    const last = prior[0];
    const chainIndex = last ? last.chainIndex + 1 : 0;
    const prevSha256 = last?.sha256 ?? null;

    // Same bytes already on this job → reupload flag (unique constraint would also catch).
    const [dup] = await tx
      .select()
      .from(jobPhotos)
      .where(and(eq(jobPhotos.jobId, input.jobId), eq(jobPhotos.sha256, hash)));
    if (dup) {
      await tx
        .update(jobPhotos)
        .set({
          integrityStatus: "reuploaded",
          integrityNote: "Identical bytes uploaded again",
        })
        .where(eq(jobPhotos.id, dup.id));
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "job_photo.reupload",
        target: `job_photo:${dup.id}`,
        tier: 1,
        outcome: "success",
        metadata: { jobId: input.jobId, sha256: hash },
      });
      return { photoId: dup.id, sha256: hash, chainIndex: dup.chainIndex, integrityStatus: "reuploaded" };
    }

    // Same filename + different hash shortly after → likely edit
    let integrityStatus: "ok" | "edited" | "broken_chain" = "ok";
    let integrityNote: string | null = null;
    if (last && last.filename === input.filename.slice(0, 200) && last.sha256 !== hash) {
      integrityStatus = "edited";
      integrityNote = "New bytes under the same filename as the previous photo";
    }
    if (last && last.integrityStatus === "broken_chain") {
      integrityStatus = "broken_chain";
      integrityNote = "Prior link in the chain was broken";
    }

    const photoId = crypto.randomUUID();
    const storageRef = path.join(input.orgId, input.jobId, `${chainIndex}-${hash.slice(0, 16)}`);
    const abs = path.join(/*turbopackIgnore: true*/ STORAGE_ROOT, storageRef);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.bytes);

    await tx.insert(jobPhotos).values({
      id: photoId,
      tenantId: input.orgId,
      jobId: input.jobId,
      sha256: hash,
      prevSha256,
      chainIndex,
      captureAt: input.captureAt,
      uploaderUserId: input.actorUserId,
      gpsLat: input.gpsLat ?? null,
      gpsLng: input.gpsLng ?? null,
      filename: input.filename.slice(0, 200),
      contentType: input.contentType.slice(0, 100),
      byteLength: input.bytes.length,
      storageRef,
      integrityStatus,
      integrityNote,
    });

    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: input.kind === "note" ? "job_note.add" : "job_photo.upload",
      target: `job_photo:${photoId}`,
      tier: 1,
      outcome: "success",
      metadata: {
        jobId: input.jobId,
        sha256: hash,
        chainIndex,
        integrityStatus,
        hasGps: input.gpsLat != null,
        byteLength: input.bytes.length,
      },
    });

    return { photoId, sha256: hash, chainIndex, integrityStatus };
  });
}

export async function verifyJobPhotoChain(input: { actorUserId: string; orgId: string; jobId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job_photo.verify");
    const rows = await tx
      .select()
      .from(jobPhotos)
      .where(eq(jobPhotos.jobId, input.jobId))
      .orderBy(asc(jobPhotos.chainIndex));

    const links: {
      id: string;
      chainIndex: number;
      sha256: string;
      prevSha256: string | null;
      integrityStatus: string;
      bytesMatch: boolean | null;
      linkOk: boolean;
      kind: "photo" | "note";
    }[] = [];

    let broken = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const expectedPrev = i === 0 ? null : rows[i - 1]!.sha256;
      const linkOk = (r.prevSha256 ?? null) === expectedPrev;
      if (!linkOk) broken = true;
      let bytesMatch: boolean | null;
      try {
        const buf = await readFile(path.join(/*turbopackIgnore: true*/ STORAGE_ROOT, r.storageRef));
        bytesMatch = sha256Buffer(buf) === r.sha256;
        if (!bytesMatch) broken = true;
      } catch {
        bytesMatch = false;
        broken = true;
      }
      links.push({
        id: r.id,
        chainIndex: r.chainIndex,
        sha256: r.sha256,
        prevSha256: r.prevSha256,
        integrityStatus: !linkOk || bytesMatch === false ? "broken_chain" : r.integrityStatus,
        bytesMatch,
        linkOk,
        kind: isNote(r.contentType) ? "note" : "photo",
      });
    }
    return {
      jobId: input.jobId,
      intact: !broken && rows.every((r) => r.integrityStatus === "ok" || r.integrityStatus === "edited" || r.integrityStatus === "reuploaded"),
      chainIntact: !broken,
      photos: links,
      flagged: rows.filter((r) => r.integrityStatus !== "ok").map((r) => ({
        id: r.id,
        status: r.integrityStatus,
        note: r.integrityNote,
      })),
    };
  });
}

/** Self-contained HTML claim packet (no PDF dependency). */
export async function exportClaimPacket(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ html: string; filename: string }> {
  const verification = await verifyJobPhotoChain(input);
  const rows = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job_photo.export");
    return tx.select().from(jobPhotos).where(eq(jobPhotos.jobId, input.jobId)).orderBy(asc(jobPhotos.chainIndex));
  });

  const status = verification.chainIntact
    ? verification.flagged.length
      ? "Chain intact · some photos flagged"
      : "Chain intact · all photos OK"
    : "INTEGRITY PROBLEM · chain or bytes do not verify";

  const photoRows = rows
    .map((r) => {
      const v = verification.photos.find((p) => p.id === r.id);
      return `<tr>
        <td>${r.chainIndex}</td>
        <td><code>${r.sha256}</code></td>
        <td><code>${r.prevSha256 ?? "—"}</code></td>
        <td>${r.captureAt.toISOString()}</td>
        <td>${r.gpsLat != null ? `${r.gpsLat.toFixed(5)}, ${r.gpsLng!.toFixed(5)}` : "—"}</td>
        <td>${r.uploaderUserId}</td>
        <td>${v?.integrityStatus ?? r.integrityStatus}</td>
        <td>${v?.bytesMatch === true ? "match" : v?.bytesMatch === false ? "MISMATCH" : "?"}</td>
      </tr>`;
    })
    .join("\n");

  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const notes: string[] = [];
  for (const r of rows.filter((x) => isNote(x.contentType))) {
    const body = await readFile(path.join(/*turbopackIgnore: true*/ STORAGE_ROOT, r.storageRef), "utf8").catch(() => "(stored note is missing)");
    notes.push(`<li><p><strong>#${r.chainIndex}</strong> · observed ${r.captureAt.toISOString()} · added ${r.uploadedAt.toISOString()}</p><p style="white-space:pre-wrap">${esc(body)}</p><p><code>${r.sha256}</code></p></li>`);
  }
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Claim packet · job ${input.jobId}</title>
<style>
  html,body{max-width:100%;overflow-x:hidden}
  body{font-family:system-ui,sans-serif;margin:1rem;color:#111;max-width:960px}
  h1{font-size:1.5rem}
  table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:0.9rem}
  th,td{border:1px solid #ccc;padding:0.5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
  code{font-size:0.75rem;word-break:break-all;overflow-wrap:anywhere}
  .banner{padding:1rem;border-radius:8px;margin:1rem 0}
  .ok{background:#ecfdf5} .warn{background:#fff7ed} .bad{background:#fef2f2}
  @media (max-width:640px){
    body{margin:0.75rem}
    table{font-size:0.75rem}
    th,td{padding:0.35rem}
    code{font-size:0.65rem;word-break:break-all}
  }
</style></head><body>
<h1>Claim packet: photos and notes</h1>
<p>Job <code>${input.jobId}</code> · Org <code>${input.orgId}</code> · Exported ${new Date().toISOString()}</p>
<div class="banner ${verification.chainIntact ? (verification.flagged.length ? "warn" : "ok") : "bad"}"><strong>${status}</strong></div>
<table>
<thead><tr><th>#</th><th>SHA-256</th><th>Prev</th><th>Captured</th><th>GPS</th><th>Uploader</th><th>Status</th><th>Bytes</th></tr></thead>
<tbody>
${photoRows || '<tr><td colspan="8">No photos</td></tr>'}
</tbody></table>
${notes.length ? `<h2>Notes</h2><ol>${notes.join("\n")}</ol>` : ""}
<p style="margin-top:2rem;color:#666;font-size:0.85rem">This packet is evidence of integrity checks performed by Scout OS. It does not prove scene authenticity by itself.</p>
</body></html>`;

  return { html, filename: `claim-packet-${input.jobId.slice(0, 8)}.html` };
}
