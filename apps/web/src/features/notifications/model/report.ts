/**
 * Where the error report of an import can still be downloaded (T552,
 * CONTRACTS §19, §12.2): the job finished (`succeeded`), its result still
 * has `download_url` (the cleanup removes it, `file_deleted`) and
 * `expires_at` (24 h) has not passed. `null` otherwise: the panel says the
 * report is gone.
 */
export function reportDownloadUrl(
  job: { readonly status: string; readonly result: Readonly<Record<string, unknown>> | null },
  now: Date,
): string | null {
  if (job.status !== 'succeeded' || job.result === null) return null;
  const url = job.result['download_url'];
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  const expiresAt = job.result['expires_at'];
  if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= now.getTime()) return null;
  return url;
}
