/**
 * One SVG path for the dark modules of a QR matrix (`true` = dark): each
 * horizontal run of dark modules is one rectangle `M x y h w v 1 h -w z`,
 * so a version-4 code is a few hundred short commands instead of one
 * `<rect>` per module.
 */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== true) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === true) x += 1;
      const width = x - start;
      parts.push(`M${String(start)} ${String(y)}h${String(width)}v1h-${String(width)}z`);
    }
  });
  return parts.join('');
}
