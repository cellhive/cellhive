import { CellSet, type ImageWindowLoader, type Rectangle } from '@glideapps/glide-data-grid';

import { thumbnailRetryDelay, thumbnailRetryUrl } from '../lib/attachments/previews';

/** What the loader needs of an image (an `HTMLImageElement` in the browser). */
export interface LoadableImage {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode?: () => Promise<void>;
}

interface Entry {
  image: LoadableImage;
  loaded: boolean;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Cells (`col,row`) drawing this image. */
  readonly cells: Set<string>;
}

const cellKey = (col: number, row: number) => `${String(col)},${String(row)}`;

/**
 * Images of the canvas (attachment thumbnails, T418): glide's own
 * `ImageWindowLoaderImpl` keeps a failed image as "loading" forever, so a
 * thumbnail asked before the worker rendered it (`404`) stayed a
 * placeholder until the page was reloaded (T421b). This one tries a failed
 * image again with the backoff of `previews.ts` (a distinct URL each time),
 * redraws the cells once an image is decoded, and forgets the images whose
 * cells all left the visible window.
 */
export class RetryingImageLoader implements ImageWindowLoader {
  readonly #create: () => LoadableImage;
  readonly #entries = new Map<string, Entry>();
  #onLoaded: (cells: CellSet) => void = () => undefined;
  #pending: [number, number][] = [];
  #flush: ReturnType<typeof setTimeout> | null = null;
  #window: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  #freezeCols = 0;
  #freezeRows: readonly number[] = [];

  constructor(create: () => LoadableImage = () => new Image() as unknown as LoadableImage) {
    this.#create = create;
  }

  setCallback(imageLoaded: (locations: CellSet) => void): void {
    this.#onLoaded = imageLoaded;
  }

  setWindow(newWindow: Rectangle, freezeCols: number, freezeRows: number[]): void {
    const same =
      this.#window.x === newWindow.x &&
      this.#window.y === newWindow.y &&
      this.#window.width === newWindow.width &&
      this.#window.height === newWindow.height &&
      this.#freezeCols === freezeCols &&
      this.#freezeRows.length === freezeRows.length &&
      this.#freezeRows.every((row, index) => row === freezeRows[index]);
    if (same) return;
    this.#window = newWindow;
    this.#freezeCols = freezeCols;
    this.#freezeRows = [...freezeRows];
    for (const [url, entry] of this.#entries) {
      for (const cell of entry.cells) {
        const [col = 0, row = 0] = cell.split(',').map(Number);
        if (!this.#inWindow(col, row)) entry.cells.delete(cell);
      }
      if (entry.cells.size > 0) continue;
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (!entry.loaded) {
        entry.image.onload = null;
        entry.image.onerror = null;
        entry.image.src = '';
      }
      this.#entries.delete(url);
    }
  }

  loadOrGetImage(
    url: string,
    col: number,
    row: number,
  ): HTMLImageElement | ImageBitmap | undefined {
    let entry = this.#entries.get(url);
    if (entry === undefined) {
      entry = { image: this.#create(), loaded: false, attempt: 0, timer: null, cells: new Set() };
      this.#entries.set(url, entry);
      this.#load(url, entry);
    }
    entry.cells.add(cellKey(col, row));
    return entry.loaded ? (entry.image as unknown as HTMLImageElement) : undefined;
  }

  #inWindow(col: number, row: number): boolean {
    const { x, y, width, height } = this.#window;
    const colIn = col < this.#freezeCols || (col >= x && col < x + width);
    const rowIn = this.#freezeRows.includes(row) || (row >= y && row < y + height);
    return colIn && rowIn;
  }

  #load(url: string, entry: Entry): void {
    const image = entry.image;
    const live = () => this.#entries.get(url) === entry && entry.image === image;
    image.onload = () => {
      const done = () => {
        if (!live()) return;
        entry.loaded = true;
        this.#redraw(entry);
      };
      if (typeof image.decode === 'function') void image.decode().then(done, done);
      else done();
    };
    image.onerror = () => {
      if (!live()) return;
      const delay = thumbnailRetryDelay(url, entry.attempt);
      if (delay === null) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!live()) return;
        entry.attempt += 1;
        entry.image = this.#create();
        this.#load(url, entry);
      }, delay);
    };
    image.src = thumbnailRetryUrl(url, entry.attempt);
  }

  /** Redraws the cells of a decoded image (batched: many images arrive together). */
  #redraw(entry: Entry): void {
    for (const cell of entry.cells) {
      const [col = 0, row = 0] = cell.split(',').map(Number);
      this.#pending.push([col, row]);
    }
    if (this.#flush !== null) return;
    this.#flush = setTimeout(() => {
      this.#flush = null;
      const cells = this.#pending;
      this.#pending = [];
      if (cells.length > 0) this.#onLoaded(new CellSet(cells));
    }, 20);
  }
}
