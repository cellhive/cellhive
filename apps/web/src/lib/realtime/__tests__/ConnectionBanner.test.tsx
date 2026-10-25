import { act, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { RECONNECTING_NOTICE_MS } from '../connection';
import { ConnectionBanner } from '../ConnectionBanner';
import { realtimeStatus } from '../status';

import type { i18n as I18n } from 'i18next';

let en: I18n;
let vi18n: I18n;

beforeAll(async () => {
  en = await createTestI18n('en');
  vi18n = await createTestI18n('vi');
});

afterEach(() => {
  act(() => {
    realtimeStatus.set({ status: 'idle' });
  });
  vi.useRealTimers();
});

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

function renderBanner(i18n: I18n = en) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ConnectionBanner />
    </I18nextProvider>,
  );
}

describe('ConnectionBanner (FRONTEND §8.3)', () => {
  it('is an empty live region while connected (not a status role)', () => {
    renderBanner();
    expect(screen.getByTestId('connection-banner')).toBeEmptyDOMElement();
    expect(screen.getByTestId('connection-banner')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the offline notice when the browser goes offline, and hides it again', () => {
    renderBanner();
    setOnline(false);
    expect(screen.getByTestId('connection-banner')).toHaveTextContent(/You are offline/u);
    setOnline(true);
    expect(screen.getByTestId('connection-banner')).toBeEmptyDOMElement();
  });

  it('stays quiet when the browser says offline but the WebSocket is open', () => {
    renderBanner();
    act(() => {
      realtimeStatus.set({ status: 'open' });
    });
    setOnline(false);
    expect(screen.getByTestId('connection-banner')).toBeEmptyDOMElement();
    setOnline(true);
  });

  it('announces a lost WebSocket only after 5 seconds', () => {
    vi.useFakeTimers();
    renderBanner();
    act(() => {
      realtimeStatus.set({ status: 'reconnecting', since: Date.now() });
    });
    act(() => {
      vi.advanceTimersByTime(RECONNECTING_NOTICE_MS - 100);
    });
    expect(screen.getByTestId('connection-banner')).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('Reconnecting…');
    act(() => {
      realtimeStatus.set({ status: 'open' });
    });
    expect(screen.getByTestId('connection-banner')).toBeEmptyDOMElement();
  });

  it('keeps the start of an outage across repeated reconnect attempts', () => {
    act(() => {
      realtimeStatus.set({ status: 'reconnecting', since: 1000 });
      realtimeStatus.set({ status: 'reconnecting', since: 9000 });
    });
    expect(realtimeStatus.get()).toEqual({ status: 'reconnecting', since: 1000 });
  });

  it('is translated', () => {
    renderBanner(vi18n);
    setOnline(false);
    expect(screen.getByTestId('connection-banner')).toHaveTextContent(/Bạn đang ngoại tuyến/u);
  });

  it('has no serious accessibility violations', async () => {
    const { container } = renderBanner();
    setOnline(false);
    expect(await axeViolations(container)).toEqual([]);
  });
});
