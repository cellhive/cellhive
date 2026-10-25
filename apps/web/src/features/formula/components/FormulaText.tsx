import { cn } from '@cellhive/ui';
import { Fragment, useMemo } from 'react';

import { iconNode, type ChipIcon } from '../model/icons';
import { CHIP_CLASS, formulaSegments, isChip, SEGMENT_CLASSES } from '../model/segments';

import type { FormulaSchema } from '../model/schema';

export function ChipIconSvg({ icon }: { icon: ChipIcon }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {iconNode(icon).map(([tag, attrs], index) => {
        const Tag = tag as 'path';
        return <Tag key={index} {...attrs} />;
      })}
    </svg>
  );
}

export interface FormulaTextProps {
  readonly source: string;
  /** `null`: sample names (catalogue examples), shown as plain chips. */
  readonly schema: FormulaSchema | null;
  readonly className?: string;
}

/**
 * A formula shown read-only with the editor's colours and chips (field
 * dialog, mobile, catalogue examples): the text as written, names as chips.
 * Screen readers read the names; brackets are not announced.
 */
export function FormulaText({ source, schema, className }: FormulaTextProps) {
  const segments = useMemo(() => formulaSegments(source, schema), [source, schema]);
  const parts: React.ReactNode[] = [];
  let position = 0;
  segments.forEach((segment, index) => {
    if (segment.from > position) {
      parts.push(
        <Fragment key={`gap${String(index)}`}>{source.slice(position, segment.from)}</Fragment>,
      );
    }
    const text = source.slice(segment.from, segment.to);
    if (isChip(segment.kind)) {
      parts.push(
        <span key={index} className={cn(CHIP_CLASS, SEGMENT_CLASSES[segment.kind])}>
          {segment.icon === undefined ? null : <ChipIconSvg icon={segment.icon} />}
          <span className="truncate">{segment.label ?? text}</span>
        </span>,
      );
    } else {
      parts.push(
        <span key={index} className={SEGMENT_CLASSES[segment.kind]}>
          {text}
        </span>,
      );
    }
    position = segment.to;
  });
  if (position < source.length) parts.push(<Fragment key="end">{source.slice(position)}</Fragment>);
  return (
    <span className={cn('font-mono text-body break-words whitespace-pre-wrap', className)}>
      {parts}
    </span>
  );
}
