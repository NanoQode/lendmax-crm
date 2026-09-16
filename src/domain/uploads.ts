/**
 * Which uploads are accepted, as a pure rule.
 *
 * Lives in the domain layer rather than in services/storage.ts so that
 * anything offering a choice of formats (the required-documents module) can be
 * tested against exactly what the uploader will take.
 */
import path from 'node:path';

/** Extensions a mortgage file legitimately contains. */
const ALLOWED = new Map<string, string[]>([
  ['application/pdf', ['.pdf']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/heic', ['.heic']],
  ['image/webp', ['.webp']],
  ['image/tiff', ['.tif', '.tiff']],
  ['application/msword', ['.doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['text/csv', ['.csv']],
]);

export const MAX_BYTES = 25 * 1024 * 1024;

export type UploadCheck = { ok: true; extension: string } | { ok: false; reason: string };

/**
 * Is this something we accept?
 *
 * The declared MIME type and the extension must agree. A browser will happily
 * declare `application/pdf` for a file called `payload.svg`, and an SVG is a
 * script that runs if it is ever served inline.
 */
export function checkUpload(filename: string, mimeType: string, bytes: number): UploadCheck {
  if (bytes <= 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB and the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
    };
  }
  const extension = path.extname(filename).toLowerCase();
  const allowed = ALLOWED.get(mimeType.toLowerCase().split(';')[0]!.trim());
  if (!allowed) {
    return {
      ok: false,
      reason: `${mimeType || 'That file type'} is not accepted. Send a PDF, a photo, or an Office document.`,
    };
  }
  if (!allowed.includes(extension)) {
    return {
      ok: false,
      reason: `The file is named "${extension}" but declares itself as ${mimeType}. Rename it and try again.`,
    };
  }
  return { ok: true, extension };
}

