import { Button, cn, Tooltip } from '@cellhive/ui';
import { Sparkles } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiAvailability } from '../../../lib/ai/use-ai-availability';

import type { AskAiEntryProps, AskAiPanelComponent } from '../../../lib/ai/ask';

export interface AskAiButtonProps extends AskAiEntryProps {
  /** The panel (`features/ai-ask`, lazy), from the route (FRONTEND §1.2). */
  readonly Panel: AskAiPanelComponent;
}

/**
 * "Ask AI" of the grid toolbar (T914, research S8 §5.1–§5.3): rendered only
 * when AI is available in the organization (`useAiAvailability`, never
 * hidden with CSS) — the panel's chunk downloads when it first opens. The
 * one AI sign: the Sparkles icon and "AI" (the full label from 1280 px).
 * A toggle: it says whether the panel is open and gets the focus back when
 * the panel closes.
 */
export function AskAiButton({ table, fields, orgId, Panel }: AskAiButtonProps) {
  const { t } = useTranslation('toolbar');
  const { available } = useAiAvailability(orgId);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!available) return null;
  const label = t('askAi.button');
  return (
    <>
      <Tooltip content={label} className="xl:hidden">
        <Button
          ref={button}
          variant="ghost"
          size="toolbar"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn('shrink-0', open && 'bg-accent-soft text-accent hover:bg-accent-soft')}
          data-testid="ask-ai-button"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <Sparkles aria-hidden="true" />
          <span aria-hidden="true" className="max-xl:hidden">
            {label}
          </span>
          <span aria-hidden="true" className="xl:hidden">
            {t('askAi.short')}
          </span>
        </Button>
      </Tooltip>
      {open ? (
        <Suspense fallback={null}>
          <Panel
            table={table}
            fields={fields}
            orgId={orgId}
            onClose={() => {
              setOpen(false);
              button.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
