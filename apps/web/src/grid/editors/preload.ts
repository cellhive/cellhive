let requested = false;

/**
 * Loads glide's overlay editor code ahead of the first edit (S3 QA): glide
 * imports it lazily when an editor first opens, which delayed the first
 * type-to-edit after a page load. Our editors are in the grid's own chunk.
 */
export function preloadOverlayEditor(): void {
  if (requested) return;
  requested = true;
  import('glide-overlay-editor').catch(() => {
    // Offline or a new deployment: glide loads it again when an editor opens.
    requested = false;
  });
}
