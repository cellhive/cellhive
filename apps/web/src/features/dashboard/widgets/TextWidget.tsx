import { Markdown } from '../../../lib/markdown/Markdown';

/**
 * A text widget (T811, SPEC §10.2): Markdown through `@cellhive/markdown`
 * rendered as React elements (FRONTEND §12 — no HTML string, no
 * `dangerouslySetInnerHTML`); links open in a new tab without the opener.
 */
export function TextWidget({ markdown }: { readonly markdown: string }) {
  return (
    <div className="size-full overflow-auto text-body text-fg" data-testid="text-widget">
      <Markdown source={markdown} />
    </div>
  );
}
