import { definitionTypeOf } from '../schema/conversion-ddl.js';

import { publishRealtime } from './bus.js';
import { REALTIME_ENVELOPE_VERSION, type FieldConvertingEnvelope } from './envelope.js';

import type { Db, Tx } from '../db/create-db.js';
import type { FieldConversionRow } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** The `field.converting` envelope of a conversion (T403). */
export function fieldConvertingEnvelope(
  conversion: FieldConversionRow,
  baseId: Id<'bse'>,
  status: FieldConvertingEnvelope['status'],
  progress: number,
): FieldConvertingEnvelope {
  return {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'field.converting',
    organization_id: conversion.organization_id,
    base_id: baseId,
    table_id: conversion.table_id,
    field_id: conversion.field_id,
    job_id: conversion.job_id,
    status,
    progress: Math.min(Math.max(progress, 0), 1),
    from_type: definitionTypeOf(conversion.from_definition),
    to_type: definitionTypeOf(conversion.to_definition),
    actor_id: conversion.created_by,
    ...(conversion.kind === 'column' ? {} : { link_change: conversion.kind }),
  };
}

/**
 * Tells everyone who has the base open and sees the field how a conversion
 * goes (BACKLOG S4 design decision #8), after `tx` commits.
 */
export async function publishFieldConverting(
  db: Db,
  tx: Tx | undefined,
  conversion: FieldConversionRow,
  baseId: Id<'bse'>,
  status: FieldConvertingEnvelope['status'],
  progress: number,
): Promise<void> {
  const envelope = fieldConvertingEnvelope(conversion, baseId, status, progress);
  await publishRealtime(db, tx, envelope);
  // A link conversion changes the other side too (T404): its table hears of it
  // (the reverse field of `to_two_way` exists once the conversion succeeded).
  if (
    conversion.partner_table_id !== null &&
    conversion.partner_field_id !== null &&
    (conversion.kind !== 'to_two_way' || status === 'succeeded')
  ) {
    await publishRealtime(db, tx, {
      ...envelope,
      table_id: conversion.partner_table_id,
      field_id: conversion.partner_field_id,
    });
  }
}
