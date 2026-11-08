import {
  BASE_PACKAGE_DEFAULT_MAX_BYTES,
  BASE_PACKAGE_MAX_COMPRESSION_RATIO,
  BASE_PACKAGE_MAX_ENTRIES,
  BASE_PACKAGE_MAX_JSON_DEPTH,
  BASE_PACKAGE_MAX_JSON_ENTRY_BYTES,
  BASE_PACKAGE_MAX_NDJSON_LINE_BYTES,
  BASE_PACKAGE_MAX_UNCOMPRESSED_FACTOR,
} from '@cellhive/contracts';

/**
 * Caps of a `.chbase` package (CONTRACTS §12.2). The reader applies every
 * one of them to untrusted packages; the writer applies the same ones so
 * that an export never produces a package an import refuses.
 */
export interface BasePackageLimits {
  /** `BASE_PACKAGE_MAX_BYTES`: the package file. */
  readonly maxPackageBytes: number;
  readonly maxEntries: number;
  /** Total uncompressed bytes ≤ this × the package size … */
  readonly maxCompressionRatio: number;
  /** … and ≤ this × `maxPackageBytes`. */
  readonly maxUncompressedFactor: number;
  readonly maxJsonEntryBytes: number;
  readonly maxNdjsonLineBytes: number;
  readonly maxJsonDepth: number;
}

export const DEFAULT_BASE_PACKAGE_LIMITS: BasePackageLimits = {
  maxPackageBytes: BASE_PACKAGE_DEFAULT_MAX_BYTES,
  maxEntries: BASE_PACKAGE_MAX_ENTRIES,
  maxCompressionRatio: BASE_PACKAGE_MAX_COMPRESSION_RATIO,
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

/** Most uncompressed bytes a package of `packageBytes` may hold: min(20 × package, 4 × cap). */
export function maxUncompressedBytes(limits: BasePackageLimits, packageBytes: number): number {
  return Math.min(
    Math.max(packageBytes, 1) * limits.maxCompressionRatio,
    limits.maxPackageBytes * limits.maxUncompressedFactor,
  );
}
