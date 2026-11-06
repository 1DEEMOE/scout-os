/**
 * Claim packet as a PDF: every photo and note on the job, in chain order,
 * each with its SHA-256, the previous item's hash, capture and upload times
 * (UTC), GPS when present and who added it, plus a fingerprint of the whole
 * packet. Anyone can re-check it with the original files and a SHA-256 tool.
 * It documents integrity checks; it doesn't by itself prove what a photo shows.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { jobPhotos, organizations, tasks, users, withGlobal } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";
import { isNote, verifyJobPhotoChain } from "./service";

const STORAGE_ROOT = process.env.WOS_JOB_PHOTO_DIR || path.join(process.cwd(), ".job-photos");

export interface PacketManifestItem {
  index: number;
  kind: "photo" | "note";
  sha256: string;
  prevSha256: string | null;
  capturedAt: string;
  uploadedAt: string;
  uploader: string;
  gps: [number, number] | null;
  bytes: number;
}

/** The packet fingerprint: SHA-256 of a canonical JSON manifest (stable key order). */
export function packetFingerprint(jobId: string, items: PacketManifestItem[]): string {
  const canon = JSON.stringify({ jobId, items: items.map((i) => [i.index, i.kind, i.sha256, i.prevSha256, i.capturedAt, i.uploadedAt, i.uploader, i.gps, i.bytes]) });
  return createHash("sha256").update(canon).digest("hex");
}

// Standard PDF fonts only cover Latin-1; replace anything else rather than fail.
const latin1 = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\t]/g, " ")
    .split("")
    .map((ch) => (ch === "\n" || (ch >= " " && ch <= "~") || (ch >= "\u00a0" && ch <= "\u00ff") ? ch : "?"))
    .join("");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of latin1(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        // Very long tokens (hashes) are broken by characters.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let cut = w.length;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export async function exportClaimPacketPdf(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ pdf: Uint8Array; filename: string; fingerprint: string }> {
  const verification = await verifyJobPhotoChain(input);
  const { rows, job, org } = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job_photo.export");
    const [job] = await tx.select({ id: tasks.id, title: tasks.title, intent: tasks.intent }).from(tasks).where(eq(tasks.id, input.jobId));
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, input.orgId));
    const rows = await tx.select().from(jobPhotos).where(eq(jobPhotos.jobId, input.jobId)).orderBy(asc(jobPhotos.chainIndex));
    return { rows, job, org };
  });
  const ids = [...new Set([...rows.map((r) => r.uploaderUserId), input.actorUserId])];
  const people = new Map((await withGlobal((tx) => tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)))).map((u) => [u.id, u.name]));
  const items: PacketManifestItem[] = rows.map((r) => ({
    index: r.chainIndex,
    kind: isNote(r.contentType) ? "note" : "photo",
    sha256: r.sha256,
    prevSha256: r.prevSha256,
    capturedAt: r.captureAt.toISOString(),
    uploadedAt: r.uploadedAt.toISOString(),
    uploader: people.get(r.uploaderUserId) ?? r.uploaderUserId,
    gps: r.gpsLat != null && r.gpsLng != null ? [r.gpsLat, r.gpsLng] : null,
    bytes: r.byteLength,
  }));
  const fingerprint = packetFingerprint(input.jobId, items);
  const generatedAt = new Date().toISOString();

  const doc = await PDFDocument.create();
  doc.setTitle(`Claim packet - ${job.title ?? job.intent}`.slice(0, 200));
  doc.setProducer("Scout OS");
  doc.setCreationDate(new Date(generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const M = 48;
  const W = 612 - M * 2;
  let page: PDFPage = doc.addPage([612, 792]);
  let y = 792 - M;
  const ink = rgb(0.08, 0.09, 0.12);
  const muted = rgb(0.34, 0.37, 0.42);
  const need = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([612, 792]);
      y = 792 - M;
    }
  };
  const text = (s: string, o: { f?: PDFFont; size?: number; color?: typeof ink; gap?: number } = {}) => {
    const size = o.size ?? 10;
    for (const line of wrap(s, o.f ?? font, size, W)) {
      need(size + 4);
      page.drawText(line, { x: M, y: y - size, size, font: o.f ?? font, color: o.color ?? ink });
      y -= size + 4;
    }
    y -= o.gap ?? 0;
  };

  text("Claim packet", { f: bold, size: 22, gap: 6 });
  text(`${org?.name ?? ""} - ${job.title ?? job.intent}`, { size: 12, gap: 2 });
  text(`Job ${input.jobId}`, { f: mono, size: 8, color: muted });
  text(`Generated ${generatedAt} (UTC) by ${people.get(input.actorUserId) ?? input.actorUserId}`, { size: 9, color: muted, gap: 10 });
  const status = !verification.chainIntact
    ? "INTEGRITY PROBLEM: the chain or the stored files do not verify."
    : verification.flagged.length
      ? "Chain intact. Some items are flagged (see each item)."
      : "Chain intact. Every item verifies against its stored file.";
  text(status, { f: bold, size: 12, color: verification.chainIntact ? ink : rgb(0.7, 0.15, 0.12), gap: 4 });
  text(`Items: ${items.filter((i) => i.kind === "photo").length} photos, ${items.filter((i) => i.kind === "note").length} notes.`, { size: 10 });
  text("Packet fingerprint (SHA-256 of the item list):", { size: 9, color: muted });
  text(fingerprint, { f: mono, size: 8, gap: 14 });

  for (const r of rows) {
    const item = items.find((i) => i.index === r.chainIndex)!;
    const v = verification.photos.find((p) => p.id === r.id);
    need(80);
    page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: rgb(0.85, 0.87, 0.9) });
    y -= 14;
    text(`#${r.chainIndex}  ${item.kind === "note" ? "Note" : "Photo"}  -  ${v?.integrityStatus ?? r.integrityStatus}${v?.bytesMatch === false ? " (stored file does not match)" : ""}`, { f: bold, size: 11, gap: 2 });
    text(`Captured ${item.capturedAt}   Added ${item.uploadedAt}   by ${item.uploader}${item.gps ? `   GPS ${item.gps[0].toFixed(5)}, ${item.gps[1].toFixed(5)}` : ""}`, { size: 8.5, color: muted });
    if (r.integrityNote) text(`Flag: ${r.integrityNote}`, { size: 8.5, color: rgb(0.6, 0.29, 0.07) });
    const bytes: Buffer | null = await readFile(path.join(/*turbopackIgnore: true*/ STORAGE_ROOT, r.storageRef)).catch(() => null);
    if (item.kind === "note") {
      y -= 2;
      text(bytes ? bytes.toString("utf8") : "(stored note is missing)", { size: 10.5, gap: 2 });
    } else if (bytes) {
      try {
        const img = r.contentType.includes("png") ? await doc.embedPng(bytes) : r.contentType.includes("jpeg") || r.contentType.includes("jpg") ? await doc.embedJpg(bytes) : null;
        if (img) {
          const scale = Math.min(260 / img.width, 200 / img.height, 1);
          const h = img.height * scale;
          need(h + 8);
          page.drawImage(img, { x: M, y: y - h, width: img.width * scale, height: h });
          y -= h + 8;
        } else text(`(${r.contentType} preview can't be embedded; the hash below covers the original file)`, { size: 8.5, color: muted });
      } catch {
        text("(preview couldn't be drawn; the hash below covers the original file)", { size: 8.5, color: muted });
      }
    }
    text(`SHA-256  ${r.sha256}`, { f: mono, size: 7.5 });
    text(`Previous ${r.prevSha256 ?? "(first item)"}`, { f: mono, size: 7.5, color: muted, gap: 8 });
  }
  if (!rows.length) text("No photos or notes on this job yet.", { color: muted });

  need(70);
  y -= 6;
  text("How to check this packet", { f: bold, size: 11, gap: 2 });
  text("1. Compute the SHA-256 of each original file (or note text) and compare it with the item's SHA-256. 2. Each item's Previous must equal the SHA-256 of the item before it. 3. Recompute the packet fingerprint from the item list. Any edit, removal or reordering breaks at least one of these.", { size: 9, color: muted, gap: 4 });
  text("This packet records integrity checks made by Scout OS. It does not, by itself, prove what a photo shows.", { size: 8.5, color: muted });

  const pdf = await doc.save();
  await inOrg(input.orgId, (tx) =>
    recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "job_photo.export_pdf", target: `task:${input.jobId}`, tier: 0, outcome: "success", metadata: { fingerprint, items: items.length, chainIntact: verification.chainIntact } }),
  );
  return { pdf, filename: `claim-packet-${input.jobId.slice(0, 8)}.pdf`, fingerprint };
}
