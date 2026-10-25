import type { SVGProps } from 'react';

/**
 * The sub-record tree icon of the design boards (a record with two
 * sub-records), drawn like the lucide icons around it (24 px grid, 1.8
 * stroke, current color).
 */
export function TreeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 3h6v4H4zM14 10h6v4h-6zM14 17h6v4h-6zM7 7v12h7M7 12h7" />
    </svg>
  );
}
