import { Button } from '@cellhive/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Chip } from '../../components/values/chips';

import { displayPath, webhookReferenceExpression, type SampleNode } from './model';

const COPIED_MS = 2000;

/**
 * The path chosen in the sample tree (BACKLOG T612): its name as the chips
 * show it, where to insert it ("+" → "Webhook data" of any value), and the
 * template reference to copy (`{{ [@body.customer.email] }}`). A key that
 * cannot be written in a path says so.
 */
export function SamplePath({ node }: { readonly node: SampleNode }) {
  const { t } = useTranslation('automationBuilder');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  if (!node.pickable) {
    return (
      <p className="text-label font-normal text-fg-muted" data-testid="sample-path-unusable">
        {t('webhook.unusableKey')}
      </p>
    );
  }
  const label = displayPath(node.part, node.pathText);
  const reference = `{{ ${webhookReferenceExpression(node.part, node.pathText)} }}`;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-sunken p-2.5"
      data-testid="sample-path"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-label text-fg">{t('webhook.chosenPath')}</span>
        <Chip name={{ tone: 'trigger', webhook: label }} />
      </div>
      <p className="text-label font-normal text-fg-muted">{t('webhook.useHint')}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code
          className="min-w-0 font-mono text-mono break-all text-fg"
          data-testid="sample-path-reference"
        >
          {reference}
        </code>
        <Button
          variant="secondary"
          size="sm"
          data-testid="sample-path-copy"
          onClick={() => {
            if (!('clipboard' in navigator)) return;
            navigator.clipboard.writeText(reference).then(
              () => {
                setCopied(true);
              },
              () => undefined,
            );
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('webhook.copied') : t('webhook.copyReference')}
        </Button>
        <span role="status" className="sr-only">
          {copied ? t('webhook.copiedAnnounce') : ''}
        </span>
      </div>
    </div>
  );
}
