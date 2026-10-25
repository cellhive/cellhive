import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { SignatureEditor } from '../components/SignatureEditor';

import type { i18n as I18n } from 'i18next';

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function Editor({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <SignatureEditor value={value} onChange={setValue} />;
}

/**
 * T527: a toolbar edit selects its sample text in the same commit as the new
 * value — typing right after "Insert link" replaces `https://` instead of
 * landing after the link (the selection used to be set a frame later).
 */
describe('signature editor: selection after a toolbar edit', () => {
  it.each([
    ['link', 'Insert link', 'Hi\n', 'https://'],
    ['bold', 'Bold', 'Hi ', 'bold text'],
  ])('selects the sample of %s at once', (_kind, button, initial, sample) => {
    render(
      <I18nextProvider i18n={i18n}>
        <Editor initial={initial} />
      </I18nextProvider>,
    );
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Signature' });
    area.focus();
    area.setSelectionRange(initial.length, initial.length);
    fireEvent.click(screen.getByRole('button', { name: button }));
    // No frame has passed: the selection must already be the sample.
    expect(document.activeElement).toBe(area);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe(sample);
  });
});
