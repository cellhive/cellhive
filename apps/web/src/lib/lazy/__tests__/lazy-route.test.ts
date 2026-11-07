import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canReloadPage,
  ChunkLoadFailed,
  isChunkLoadError,
  lazyRoute,
  RELOAD_KEY,
  reloadPage,
  retryChunk,
  RETRY_DELAY_MS,
} from '../lazy-route';

const CHUNK = 'http://localhost/assets/AccountPage-Bx1.js';
const chromium = new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);

describe('isChunkLoadError (T902)', () => {
  it.each<[string, unknown, boolean]>([
    ['Chromium', chromium, true],
    ['Firefox', new TypeError(`error loading dynamically imported module: ${CHUNK}`), true],
    ['Safari', new TypeError('Importing a module script failed.'), true],
    [
      'webpack ChunkLoadError',
      Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' }),
      true,
    ],
    ['a render error', new TypeError("Cannot read properties of undefined (reading 'id')"), false],
    ['a failed request', new TypeError('Failed to fetch'), false],
    ['a string', `Failed to fetch dynamically imported module: ${CHUNK}`, false],
    ['nothing', undefined, false],
  ])('%s → %s', (_, error, expected) => {
    expect(isChunkLoadError(error)).toBe(expected);
  });

  it('recognises what Vite reports with `vite:preloadError`', () => {
    const error = new Error('Unable to preload CSS for /assets/AccountPage-Bx1.css');
    expect(isChunkLoadError(error)).toBe(false);
    window.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload: error }));
    expect(isChunkLoadError(error)).toBe(true);
  });
});

describe('retryChunk (T902)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once when the chunk loads', async () => {
    const load = vi.fn(() => Promise.resolve('page'));
    await expect(retryChunk(load)()).resolves.toBe('page');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tries once more after 500 ms when the chunk fails', async () => {
    const load = vi.fn().mockRejectedValueOnce(chromium).mockResolvedValueOnce('page');
    const loading = retryChunk(load)();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(loading).resolves.toBe('page');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('throws ChunkLoadFailed after the second failure; a new call loads the chunk again', async () => {
    const again = new TypeError('Importing a module script failed.');
    const load = vi
      .fn()
      .mockRejectedValueOnce(chromium)
      .mockRejectedValueOnce(again)
      .mockResolvedValueOnce('page');
    const loadChunk = retryChunk(load);
    const loading = loadChunk();
    const failed = expect(loading).rejects.toBeInstanceOf(ChunkLoadFailed);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await failed;
    await expect(loading).rejects.toHaveProperty('cause', again);
    expect(load).toHaveBeenCalledTimes(2);
    // "Try again".
    await expect(loadChunk()).resolves.toBe('page');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('lets any other error through at once, without a retry', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    const load = vi.fn(() => Promise.reject(bug));
    await expect(retryChunk(load)()).rejects.toBe(bug);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('lets a non-chunk error of the second attempt through as it is', async () => {
    const bug = new SyntaxError('Unexpected token');
    const load = vi.fn().mockRejectedValueOnce(chromium).mockRejectedValueOnce(bug);
    const loading = retryChunk(load)();
    const failed = expect(loading).rejects.toBe(bug);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await failed;
  });
});

describe('lazyRoute (T902)', () => {
  it('gives React Router the route module', async () => {
    const module = { Component: () => null };
    await expect(lazyRoute(() => Promise.resolve(module))()).resolves.toBe(module);
  });

  it('turns a failure into a component that throws it, for the route error boundary', async () => {
    vi.useFakeTimers();
    const loading = lazyRoute(() => Promise.reject(chromium))();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const module = await loading;
    vi.useRealTimers();
    expect(() => module.Component()).toThrow(ChunkLoadFailed);
  });
});

describe('"Reload page" guard (T902)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('is offered, then not again for a minute after a reload, so it can never loop', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    expect(canReloadPage()).toBe(true);
    reloadPage();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(canReloadPage()).toBe(false);
    sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 61_000));
    expect(canReloadPage()).toBe(true);
  });

  it('still reloads when the storage is blocked', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(canReloadPage()).toBe(true);
    reloadPage();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
