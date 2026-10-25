import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { dashboardPath, dashboardsQuery } from '../../../lib/query/dashboards';

/** URL search parameters of TV mode (FRONTEND §2): `?tv=1`, `&rotate=<seconds>`. */
export const TV_PARAM = 'tv';
export const ROTATE_PARAM = 'rotate';
/** Rotation periods offered, in seconds (0: off, the default). */
export const ROTATE_CHOICES = [0, 30, 60, 300] as const;

function subscribeFullscreen(onChange: () => void) {
  document.addEventListener('fullscreenchange', onChange);
  return () => {
    document.removeEventListener('fullscreenchange', onChange);
  };
}
const isFullscreen = () => document.fullscreenElement !== null;

/** Fullscreen of the whole page (Fullscreen API), ignored where the browser refuses it. */
export function requestFullscreen(): void {
  const root = document.documentElement;
  if (typeof root.requestFullscreen !== 'function' || document.fullscreenElement !== null) return;
  root.requestFullscreen().catch(() => undefined);
}

export function exitFullscreen(): void {
  if (document.fullscreenElement === null || typeof document.exitFullscreen !== 'function') return;
  document.exitFullscreen().catch(() => undefined);
}

export interface TvMode {
  readonly on: boolean;
  readonly fullscreen: boolean;
  /** Seconds between dashboards (0: no rotation). */
  readonly rotate: number;
  readonly enter: () => void;
  readonly exit: () => void;
  readonly toggleFullscreen: () => void;
  readonly setRotate: (seconds: number) => void;
}

/**
 * (T813, research §5) TV mode of a dashboard, `?tv=1`: the dashboard alone
 * on the screen — the app frame hidden, the page in fullscreen when the
 * browser allows it (entering from the button; a link with `?tv=1` covers
 * the window and offers the fullscreen button). Escape leaves it (leaving
 * fullscreen with the browser's own Escape leaves TV mode too). Numbers
 * stay live through realtime. Optional rotation through the base's
 * dashboards (`&rotate=60`), off by default.
 */
export function useTvMode(
  baseId: string,
  dashboardId: string,
  options: { readonly rotation?: boolean } = {},
): TvMode {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const on = params.get(TV_PARAM) === '1';
  const rotateRaw = Number(params.get(ROTATE_PARAM) ?? '0');
  // (T814) A share link shows one dashboard: no rotation through the base's.
  const rotate =
    options.rotation !== false && (ROTATE_CHOICES as readonly number[]).includes(rotateRaw)
      ? rotateRaw
      : 0;
  const fullscreen = useSyncExternalStore(subscribeFullscreen, isFullscreen, () => false);
  const wasFullscreen = useRef(false);

  const exit = useCallback(() => {
    exitFullscreen();
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(TV_PARAM);
      next.delete(ROTATE_PARAM);
      return next;
    });
  }, [setParams]);
  const enter = useCallback(() => {
    // In the click's own task: browsers grant fullscreen only to a user gesture.
    requestFullscreen();
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set(TV_PARAM, '1');
      return next;
    });
  }, [setParams]);
  const setRotate = useCallback(
    (seconds: number) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (seconds === 0) next.delete(ROTATE_PARAM);
          else next.set(ROTATE_PARAM, String(seconds));
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Escape leaves TV mode; so does leaving fullscreen (the browser's Escape never reaches the page).
  useEffect(() => {
    if (!on) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A menu, dialog or open filter list closes first.
      if (document.querySelector('[role="menu"], dialog[open], [data-testid$="-panel"]') !== null) {
        return;
      }
      exit();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [on, exit]);
  useEffect(() => {
    if (!on) {
      wasFullscreen.current = false;
      return;
    }
    if (fullscreen) wasFullscreen.current = true;
    else if (wasFullscreen.current) {
      wasFullscreen.current = false;
      exit();
    }
  }, [on, fullscreen, exit]);
  // Leaving the page (another route) leaves fullscreen.
  useEffect(
    () => () => {
      exitFullscreen();
    },
    [],
  );

  const dashboards = useQuery({ ...dashboardsQuery(baseId), enabled: on && rotate > 0 });
  useEffect(() => {
    if (!on || rotate === 0) return;
    const items = dashboards.data?.items ?? [];
    if (items.length < 2) return;
    const index = items.findIndex((item) => item.id === dashboardId);
    const next = items[(index + 1) % items.length];
    if (next === undefined) return;
    const timer = setTimeout(() => {
      void navigate(
        `${dashboardPath(baseId, next.id)}?${TV_PARAM}=1&${ROTATE_PARAM}=${String(rotate)}`,
        { replace: true },
      );
    }, rotate * 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [on, rotate, dashboards.data, dashboardId, baseId, navigate]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) {
      // Leaving fullscreen with the button keeps TV mode (in the window).
      wasFullscreen.current = false;
      exitFullscreen();
    } else {
      requestFullscreen();
    }
  }, [fullscreen]);

  return { on, fullscreen, rotate, enter, exit, toggleFullscreen, setRotate };
}
