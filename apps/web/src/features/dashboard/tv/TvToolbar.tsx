import { Button, Select } from '@cellhive/ui';
import { Maximize, Minimize, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ROTATE_CHOICES, type TvMode } from './use-tv-mode';

/**
 * (T813) The bar of TV mode in place of the page heading: the dashboard's
 * name, fullscreen on/off, the rotation through the base's dashboards (off
 * by default) and "Exit TV mode" (also Escape).
 */
export function TvToolbar({
  name,
  tv,
  rotation = true,
}: {
  readonly name: string;
  readonly tv: TvMode;
  /** (T814) Off on a share link: it shows one dashboard. */
  readonly rotation?: boolean;
}) {
  const { t } = useTranslation('dashboard');
  const rotateId = useId();
  return (
    <header
      className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6"
      data-testid="dashboard-tv-bar"
    >
      <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-fg">{name}</h1>
      {rotation ? (
        <div className="flex items-center gap-2">
          <label htmlFor={rotateId} className="text-label text-fg-muted">
            {t('tv.rotate')}
          </label>
          <Select
            id={rotateId}
            className="w-auto"
            value={String(tv.rotate)}
            onChange={(event) => {
              tv.setRotate(Number(event.target.value));
            }}
          >
            {ROTATE_CHOICES.map((seconds) => (
              <option key={seconds} value={String(seconds)}>
                {seconds === 0
                  ? t('tv.rotateOff')
                  : seconds < 60
                    ? t('tv.seconds', { count: seconds })
                    : t('tv.minutes', { count: seconds / 60 })}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <Button variant="secondary" aria-pressed={tv.fullscreen} onClick={tv.toggleFullscreen}>
        {tv.fullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
        {t('tv.fullscreen')}
      </Button>
      <Button variant="secondary" onClick={tv.exit} data-testid="dashboard-tv-exit">
        <X aria-hidden="true" />
        {t('tv.exit')}
      </Button>
    </header>
  );
}
