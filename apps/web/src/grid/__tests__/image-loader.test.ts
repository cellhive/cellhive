import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THUMBNAIL_RETRY_DELAYS_MS } from '../../lib/attachments/previews';
import { RetryingImageLoader, type LoadableImage } from '../image-loader';

import type { CellSet } from '@glideapps/glide-data-grid';

class FakeImage implements LoadableImage {
  static all: FakeImage[] = [];
  src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeImage.all.push(this);
  }

  decode(): Promise<void> {
    return Promise.resolve();
  }
}

const URL_ = '/api/v1/files/att_1/thumbnail';

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('grid image loader (T421b: a missing thumbnail is asked again)', () => {
  let loaded: [number, number][][];
  let loader: RetryingImageLoader;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeImage.all = [];
    loaded = [];
    loader = new RetryingImageLoader(() => new FakeImage());
    loader.setCallback((cells: CellSet) => {
      loaded.push([...cells.values()].map((cell) => [cell[0], cell[1]]));
    });
    loader.setWindow({ x: 0, y: 0, width: 10, height: 20 }, 0, []);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once per URL and redraws the cells that asked', async () => {
    expect(loader.loadOrGetImage(URL_, 2, 3)).toBeUndefined();
    expect(loader.loadOrGetImage(URL_, 2, 4)).toBeUndefined();
    expect(FakeImage.all).toHaveLength(1);
    expect(FakeImage.all[0]?.src).toBe(URL_);
    FakeImage.all[0]?.onload?.();
    await flush();
    vi.runOnlyPendingTimers();
    expect(loaded.flat()).toEqual([
      [2, 3],
      [2, 4],
    ]);
    expect(loader.loadOrGetImage(URL_, 2, 3)).toBe(FakeImage.all[0]);
  });

  it('tries a failed image again with backoff, then draws it', async () => {
    loader.loadOrGetImage(URL_, 1, 1);
    FakeImage.all[0]?.onerror?.();
    expect(loader.loadOrGetImage(URL_, 1, 1)).toBeUndefined();
    expect(FakeImage.all).toHaveLength(1);
    vi.advanceTimersByTime(THUMBNAIL_RETRY_DELAYS_MS[0] ?? 0);
    expect(FakeImage.all).toHaveLength(2);
    expect(FakeImage.all[1]?.src).toBe(`${URL_}?retry=1`);
    FakeImage.all[1]?.onload?.();
    await flush();
    vi.runOnlyPendingTimers();
    expect(loaded.flat()).toEqual([[1, 1]]);
    expect(loader.loadOrGetImage(URL_, 1, 1)).toBe(FakeImage.all[1]);
  });

  it('stops trying after the last delay', () => {
    loader.loadOrGetImage(URL_, 1, 1);
    for (const delay of THUMBNAIL_RETRY_DELAYS_MS) {
      FakeImage.all.at(-1)?.onerror?.();
      vi.advanceTimersByTime(delay);
    }
    FakeImage.all.at(-1)?.onerror?.();
    vi.advanceTimersByTime(120_000);
    expect(FakeImage.all).toHaveLength(THUMBNAIL_RETRY_DELAYS_MS.length + 1);
    expect(loader.loadOrGetImage(URL_, 1, 1)).toBeUndefined();
  });

  it('forgets images that scrolled out of the window (no retry for them)', () => {
    loader.loadOrGetImage(URL_, 1, 1);
    FakeImage.all[0]?.onerror?.();
    loader.setWindow({ x: 0, y: 100, width: 10, height: 20 }, 0, []);
    vi.advanceTimersByTime(60_000);
    expect(FakeImage.all).toHaveLength(1);
    // Back in view: asked afresh.
    loader.loadOrGetImage(URL_, 1, 105);
    expect(FakeImage.all).toHaveLength(2);
    expect(FakeImage.all[1]?.src).toBe(URL_);
  });
});
