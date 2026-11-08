import {
  BASE_PACKAGE_DEFAULT_MAX_BYTES,
  BASE_PACKAGE_MAX_ENTRIES,
  BASE_PACKAGE_MAX_ENTRY_RATIO,
  BASE_PACKAGE_MAX_JSON_DEPTH,
  BASE_PACKAGE_MAX_JSON_ENTRY_BYTES,
  BASE_PACKAGE_MAX_NDJSON_ENTRY_RATIO,
  BASE_PACKAGE_MAX_NDJSON_LINE_BYTES,
  BASE_PACKAGE_MAX_UNCOMPRESSED_FACTOR,
} from '@cellhive/contracts';

import { isNdjsonEntry, type PackageEntryKind } from './entries.js';

/**
 * Caps of a `.chbase` package (CONTRACTS §12.2). The reader applies every
 * one of them to untrusted packages; the writer applies the same ones so
 * that an export never produces a package an import refuses.
 */
export interface BasePackageLimits {
  /** `BASE_PACKAGE_MAX_BYTES`: the package file. */
  readonly maxPackageBytes: number;
  readonly maxEntries: number;
  /** A JSON entry or a file inflates to ≤ this × its compressed size. */
  readonly maxEntryRatio: number;
  /** An NDJSON entry inflates to ≤ this × its compressed size. */
  readonly maxNdjsonEntryRatio: number;
  /** All entries together inflate to ≤ this × `maxPackageBytes`. */
  readonly maxUncompressedFactor: number;
  readonly maxJsonEntryBytes: number;
  readonly maxNdjsonLineBytes: number;
  readonly maxJsonDepth: number;
}

export const DEFAULT_BASE_PACKAGE_LIMITS: BasePackageLimits = {
  maxPackageBytes: BASE_PACKAGE_DEFAULT_MAX_BYTES,
  maxEntries: BASE_PACKAGE_MAX_ENTRIES,
  maxEntryRatio: BASE_PACKAGE_MAX_ENTRY_RATIO,
  maxNdjsonEntryRatio: BASE_PACKAGE_MAX_NDJSON_ENTRY_RATIO,
  maxUncompressedFactor: BASE_PACKAGE_MAX_UNCOMPRESSED_FACTOR,
  maxJsonEntryBytes: BASE_PACKAGE_MAX_JSON_ENTRY_BYTES,
  maxNdjsonLineBytes: BASE_PACKAGE_MAX_NDJSON_LINE_BYTES,
  maxJsonDepth: BASE_PACKAGE_MAX_JSON_DEPTH,
};

/**
 * The limits for `maxPackageBytes` (`config.limits.basePackageMaxBytes`),
 * other caps at their CONTRACTS §12.2 values unless overridden (tests).
 */
export function basePackageLimits(
  maxPackageBytes: number = BASE_PACKAGE_DEFAULT_MAX_BYTES,
  overrides: Partial<Omit<BasePackageLimits, 'maxPackageBytes'>> = {},
): BasePackageLimits {
  return { ...DEFAULT_BASE_PACKAGE_LIMITS, ...overrides, maxPackageBytes };
}

/** Most uncompressed bytes of all entries of a package: 4 × `maxPackageBytes`. */
export function maxUncompressedBytes(limits: BasePackageLimits): number {
  return limits.maxPackageBytes * limits.maxUncompressedFactor;
}

/** The compression ratio an entry of `kind` may have (unknown names: the strict one). */
export function maxEntryRatioOf(limits: BasePackageLimits, kind: PackageEntryKind | null): number {
  return kind !== null && isNdjsonEntry(kind) ? limits.maxNdjsonEntryRatio : limits.maxEntryRatio;
}

/**
 * Whether an entry inflating from `compressed` to `uncompressed` bytes is
 * over its ratio (an empty compressed stream counts as one byte).
 */
export function exceedsEntryRatio(
  limits: BasePackageLimits,
  kind: PackageEntryKind | null,
  compressed: number,
  uncompressed: number,
): boolean {
  return uncompressed > Math.max(compressed, 1) * maxEntryRatioOf(limits, kind);
}

/** Headroom of {@link deflateStaysWithinRatio}: the measured size may differ from the written one. */
const RATIO_HEADROOM = 0.9;

/**
 * Whether deflating an entry that measured `deflated` bytes (zlib level 6,
 * as written) from `uncompressed` keeps it within its ratio, with 10 %
 * headroom; when it does not, the writer stores the entry (ratio 1).
 */
export function deflateStaysWithinRatio(
  limits: BasePackageLimits,
  kind: PackageEntryKind | null,
  deflated: number,
  uncompressed: number,
): boolean {
  return uncompressed <= Math.max(deflated, 1) * maxEntryRatioOf(limits, kind) * RATIO_HEADROOM;
}
