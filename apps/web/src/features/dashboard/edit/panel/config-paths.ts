/**
 * Reading and replacing values deep in a widget config (T812 panel). Pure;
 * a path is a list of keys and array indexes, like zod issue paths.
 */

export type ConfigPath = readonly (string | number)[];
export type Config = Readonly<Record<string, unknown>>;

export function getIn(value: unknown, path: ConfigPath): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** A copy of `value` with `path` set to `next` (`undefined` removes an object key). */
export function setIn<T>(value: T, path: ConfigPath, next: unknown): T {
  if (path.length === 0) return next as T;
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(value)) {
    const copy = [...(value as unknown[])];
    copy[key as number] = setIn(copy[key as number], rest, next);
    return copy as T;
  }
  const object =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const child = setIn(object[key], rest, next);
  if (child === undefined) {
    return Object.fromEntries(Object.entries(object).filter(([name]) => name !== String(key))) as T;
  }
  return { ...object, [key]: child } as T;
}

/** `["metrics", 0, "field"]` → `metrics[0].field` (the issue paths of `config-issues.ts`). */
export function pathKey(path: ConfigPath): string {
  return path.reduce<string>((joined, part) => {
    if (typeof part === 'number') return `${joined}[${String(part)}]`;
    return joined === '' ? part : `${joined}.${part}`;
  }, '');
}

export function stringAt(config: Config, path: ConfigPath): string | null {
  const value = getIn(config, path);
  return typeof value === 'string' ? value : null;
}

export function numberAt(config: Config, path: ConfigPath): number | null {
  const value = getIn(config, path);
  return typeof value === 'number' ? value : null;
}

export function booleanAt(config: Config, path: ConfigPath, fallback: boolean): boolean {
  const value = getIn(config, path);
  return typeof value === 'boolean' ? value : fallback;
}

/** The array at `path` (its items as the caller knows them), or `fallback`. */
export function arrayAt<T>(
  config: Config,
  path: ConfigPath,
  fallback: readonly T[] = [],
): readonly T[] {
  const value = getIn(config, path);
  return Array.isArray(value) ? (value as readonly T[]) : fallback;
}
