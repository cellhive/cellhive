/**
 * The last `.chbase` export started from this tab for a base (FRONTEND
 * §17.5): the export page shows its progress or its download again after
 * the user went elsewhere (the download link stays valid for an hour,
 * CONTRACTS §12.2). Only the job id, in `sessionStorage` (this tab), never
 * the link itself; storage that is unavailable keeps nothing.
 */
const JOB_ID = /^job_[0-9A-Za-z]{16}$/u;

function storageKey(baseId: string): string {
  return `cellhive.baseExport.${baseId}`;
}

export function readLastExport(baseId: string): string | null {
  try {
    const value = window.sessionStorage.getItem(storageKey(baseId));
    return value !== null && JOB_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastExport(baseId: string, jobId: string | null): void {
  try {
    if (jobId === null) window.sessionStorage.removeItem(storageKey(baseId));
    else window.sessionStorage.setItem(storageKey(baseId), jobId);
  } catch {
    // Storage unavailable (private mode, blocked site data): nothing to remember.
  }
}
