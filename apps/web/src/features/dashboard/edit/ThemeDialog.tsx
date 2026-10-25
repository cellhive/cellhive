import { Dialog } from '@cellhive/ui';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { DASHBOARD_PALETTES, DASHBOARD_PALETTE_IDS, densityOf, paletteIdOf } from '../model/theme';

import type { DashboardTheme } from '@cellhive/contracts';

const MODES = ['system', 'light', 'dark'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;

function Choice({
  name,
  value,
  checked,
  label,
  extra,
  onChange,
}: {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly label: string;
  readonly extra?: ReactNode;
  readonly onChange: () => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-8 items-center gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="size-4 shrink-0"
      />
      <label htmlFor={id} className="flex flex-1 items-center gap-2 text-body text-fg">
        {label}
        {extra}
      </label>
    </div>
  );
}

function Swatches({ colors }: { readonly colors: readonly string[] }) {
  return (
    <span aria-hidden="true" className="ml-auto flex gap-0.5">
      {colors.map((color) => (
        <span
          key={color}
          className="size-3.5 rounded-sm border border-line"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

/**
 * Theme of the dashboard (T812, SPEC §10.1): light, dark or the viewer's
 * own theme; the series palette (the app's, or one of three sets readable
 * in both themes); compact or comfortable spacing. Every choice applies and
 * saves at once (one undo step each).
 */
export function ThemeDialog({
  open,
  theme,
  onChange,
  onClose,
}: {
  readonly open: boolean;
  readonly theme: DashboardTheme;
  readonly onChange: (theme: DashboardTheme) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const mode = theme.mode ?? 'system';
  const palette = paletteIdOf(theme.palette);
  const density = densityOf(theme);
  const name = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('edit.theme.title')}
      closeLabel={t('edit.theme.close')}
      layout="sheet"
    >
      <div className="flex flex-col gap-5" data-testid="dashboard-theme-dialog">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label font-semibold text-fg">{t('edit.theme.mode')}</legend>
          {MODES.map((value) => (
            <Choice
              key={value}
              name={`${name}-mode`}
              value={value}
              checked={mode === value}
              label={t(`edit.theme.modes.${value}`)}
              onChange={() => {
                onChange({ ...theme, mode: value });
              }}
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label font-semibold text-fg">
            {t('edit.theme.palette')}
          </legend>
          {DASHBOARD_PALETTE_IDS.map((value) => {
            const colors = DASHBOARD_PALETTES[value];
            return (
              <Choice
                key={value}
                name={`${name}-palette`}
                value={value}
                checked={palette === value}
                label={t(`edit.theme.palettes.${value}`)}
                extra={colors === null ? null : <Swatches colors={colors} />}
                onChange={() => {
                  onChange({ ...theme, palette: colors === null ? null : [...colors] });
                }}
              />
            );
          })}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label font-semibold text-fg">
            {t('edit.theme.density')}
          </legend>
          {DENSITIES.map((value) => (
            <Choice
              key={value}
              name={`${name}-density`}
              value={value}
              checked={density === value}
              label={t(`edit.theme.densities.${value}`)}
              onChange={() => {
                onChange({ ...theme, density: value });
              }}
            />
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}
