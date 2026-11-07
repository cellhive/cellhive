import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, createRef, Suspense, type ReactNode, type Ref } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { lazyPanel } from '../chunk-error';
import { RELOAD_KEY } from '../lazy-route';

import type { i18n as I18n } from 'i18next';

let en: I18n;
let vi_: I18n;

beforeAll(async () => {
  [en, vi_] = await Promise.all([createTestI18n('en'), createTestI18n('vi')]);
});

beforeEach(() => {
  sessionStorage.clear();
  // React reports errors caught by boundaries on the console; keep the output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/Panel.js');

function Panel({ name }: { name: string }) {
  return <p>Panel of {name}</p>;
}

/** A panel chunk that fails `failures` times, then loads. */
function flakyPanel(failures: number, variant?: 'inline' | 'overlay') {
  let left = failures;
  const load = vi.fn(() =>
    left-- > 0 ? Promise.reject(chunkError()) : Promise.resolve({ default: Panel }),
  );
  return { load, LazyPanel: lazyPanel(load, variant) };
}

class Outer extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error === null ? this.props.children : <p>Outer boundary</p>;
  }
}

function renderPage(panel: ReactNode, i18n: I18n = en) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Outer>
        <main>
          <h1>Grid</h1>
          <Suspense fallback={null}>{panel}</Suspense>
        </main>
      </Outer>
    </I18nextProvider>,
  );
}

describe('lazyPanel (T902, FRONTEND §8.2)', () => {
  it('loads the panel after one automatic retry', async () => {
    const { load, LazyPanel } = flakyPanel(1);
    renderPage(<LazyPanel name="Task 1" />);
    expect(await screen.findByText('Panel of Task 1')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps a failure inside the panel; "Try again" loads it', async () => {
    const { load, LazyPanel } = flakyPanel(2);
    const { container } = renderPage(<LazyPanel name="Task 1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load this part");
    expect(alert).toHaveTextContent('Check your connection and try again.');
    // The rest of the page keeps working.
    expect(screen.getByRole('heading', { name: 'Grid' })).toBeVisible();
    expect(screen.queryByText('Outer boundary')).toBeNull();
    expect(alert.closest('.fixed')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Panel of Task 1')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('floats the message of an overlay (dialog, drawer, toolbar menu) at the bottom', async () => {
    const { LazyPanel } = flakyPanel(2, 'overlay');
    const { container } = renderPage(<LazyPanel name="Task 1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.closest('.fixed')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('loads the chunk again the next time the panel opens', async () => {
    const { LazyPanel } = flakyPanel(2);
    const { unmount } = renderPage(<LazyPanel name="Task 1" />);
    expect(await screen.findByRole('alert')).toBeVisible();
    unmount();
    renderPage(<LazyPanel name="Task 2" />);
    expect(await screen.findByText('Panel of Task 2')).toBeVisible();
  });

  it('shows the message again when "Try again" fails too', async () => {
    const { load, LazyPanel } = flakyPanel(4);
    renderPage(<LazyPanel name="Task 1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    // The retry and its own retry fail: the message again, never a blank panel.
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(4);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this part");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Panel of Task 1')).toBeVisible();
  });

  it('passes a ref on to the panel', async () => {
    function Field({ ref }: { ref?: Ref<HTMLInputElement> }) {
      return <input ref={ref} aria-label="Field" />;
    }
    const LazyField = lazyPanel(() => Promise.resolve({ default: Field }));
    const ref = createRef<HTMLInputElement>();
    renderPage(<LazyField ref={ref} />);
    const field = await screen.findByRole('textbox', { name: 'Field' });
    expect(ref.current).toBe(field);
  });

  it('passes any other error on to the boundary above', async () => {
    const LazyPanel = lazyPanel<object>(() => Promise.reject(new TypeError('x is not a function')));
    renderPage(<LazyPanel />);
    expect(await screen.findByText('Outer boundary')).toBeVisible();
  });

  it('does not offer "Reload page" again right after it was used', async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    const { LazyPanel } = flakyPanel(2);
    renderPage(<LazyPanel name="Task 1" />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('is translated (vi)', async () => {
    const { LazyPanel } = flakyPanel(2);
    renderPage(<LazyPanel name="Task 1" />, vi_);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tải được phần này');
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tải lại trang' })).toBeVisible();
  });
});
