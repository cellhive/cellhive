import type { GridRecord } from './types';
import type { GridCell } from '@glideapps/glide-data-grid';

/**
 * Built cells by record object and column. Glide asks for every visible cell
 * on every frame; formatting (Intl, dates) once per record keeps scrolling
 * at 60 fps (FRONTEND §11.1). Records are immutable: a changed record is a
 * new object, so stale cells are never returned, and old records are
 * garbage-collected with their cells.
 */
export class CellCache {
  readonly #cells = new WeakMap<GridRecord, (GridCell | undefined)[]>();

  get(record: GridRecord, column: number, build: () => GridCell): GridCell {
    let row = this.#cells.get(record);
    if (row === undefined) {
      row = [];
      this.#cells.set(record, row);
    }
    let cell = row[column];
    if (cell === undefined) {
      cell = build();
      row[column] = cell;
    }
    return cell;
  }
}

/** One value built per string key (the few blank cells of spacers and "+" rows, T320a). */
export class KeyedCache<V> {
  readonly #values = new Map<string, V>();

  get(key: string, build: () => V): V {
    let value = this.#values.get(key);
    if (value === undefined) {
      value = build();
      this.#values.set(key, value);
    }
    return value;
  }
}

/** One value built per key object (group headers, T312); dropped with the key. */
export class ObjectCache<K extends object, V> {
  readonly #values = new WeakMap<K, V>();

  get(key: K, build: () => V): V {
    let value = this.#values.get(key);
    if (value === undefined) {
      value = build();
      this.#values.set(key, value);
    }
    return value;
  }
}
