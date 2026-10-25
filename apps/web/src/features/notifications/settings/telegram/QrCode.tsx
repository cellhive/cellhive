import { encode } from 'uqr';

import { qrPath } from './qr-path';

/**
 * QR code of a `t.me` link, to open it on a phone (BACKLOG T555): a lazy
 * chunk with `uqr` (MIT, no dependency, ~4 KB gzip), drawn as one SVG path —
 * no `innerHTML`, no image request, nothing leaves the browser. Dark
 * modules on a white tile in both themes: scanners need the contrast.
 */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const qr = encode(value, { ecc: 'M', border: 2 });
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="telegram-qr"
      viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
      shapeRendering="crispEdges"
      className="size-40 shrink-0 rounded-md"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qrPath(qr.data)} fill="#000000" />
    </svg>
  );
}

export default QrCode;
