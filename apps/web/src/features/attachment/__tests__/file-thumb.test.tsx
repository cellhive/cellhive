import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localPreviews, THUMBNAIL_RETRY_DELAYS_MS } from '../../../lib/attachments/previews';
import { FileThumb } from '../components/FileThumb';

const PHOTO = {
  id: 'att_Photo00000000001',
  name: 'front.png',
  mime: 'image/png',
  url: '/api/v1/files/att_Photo00000000001',
  thumbnail_url: '/api/v1/files/att_Photo00000000001/thumbnail',
};

describe('file thumbnail (T421b: a thumbnail not rendered yet comes later)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localPreviews.clear();
  });

  it('asks again with backoff after a failure, then shows the image', () => {
    const { container } = render(<FileThumb file={PHOTO} canView={false} />);
    const first = container.querySelector('img');
    expect(first).toHaveAttribute('src', PHOTO.thumbnail_url);
    fireEvent.error(first as HTMLImageElement);
    // Waiting: the placeholder, not a broken image.
    expect(container.querySelector('img')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(THUMBNAIL_RETRY_DELAYS_MS[0] ?? 0);
    });
    const second = container.querySelector('img');
    expect(second).toHaveAttribute('src', `${PHOTO.thumbnail_url}?retry=1`);
    fireEvent.error(second as HTMLImageElement);
    act(() => {
      vi.advanceTimersByTime(THUMBNAIL_RETRY_DELAYS_MS[1] ?? 0);
    });
    expect(container.querySelector('img')).toHaveAttribute('src', `${PHOTO.thumbnail_url}?retry=2`);
  });

  it('gives up after the last try: a placeholder', () => {
    const { container } = render(<FileThumb file={PHOTO} canView={false} />);
    for (const delay of THUMBNAIL_RETRY_DELAYS_MS) {
      fireEvent.error(container.querySelector('img') as HTMLImageElement);
      act(() => {
        vi.advanceTimersByTime(delay);
      });
    }
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws an image uploaded in this tab from its local copy', () => {
    localPreviews.remember(PHOTO.id, 'blob:front');
    const { container } = render(<FileThumb file={PHOTO} canView={false} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:front');
  });
});
