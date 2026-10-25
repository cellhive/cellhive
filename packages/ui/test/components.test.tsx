import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button, cn, FormField, Input } from '../src/index';

describe('cn', () => {
  it.each([
    [['text-body text-fg', 'text-label'], 'text-fg text-label'],
    [['text-body text-fg', 'text-fg-muted'], 'text-body text-fg-muted'],
    [['h-control px-3', 'px-2'], 'h-control px-2'],
    [['rounded-md', 'rounded-lg'], 'rounded-lg'],
  ])('merges %j into %s', (inputs, expected) => {
    expect(cn(...inputs)).toBe(expected);
  });
});

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>go</Button>);
    expect(screen.getByRole('button', { name: 'go' })).toHaveAttribute('type', 'button');
  });

  it('renders its child with button styles when asChild is set', () => {
    render(
      <Button asChild variant="secondary">
        <a href="/x">link</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'link' })).toHaveClass('border-line-strong');
  });
});

describe('FormField', () => {
  it('links the label, the control, the hint and the error message', () => {
    render(
      <FormField label="Email" error="Required" hint="Work address">
        {(control) => <Input {...control} />}
      </FormField>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Work address Required');
  });

  it('is valid without an error', () => {
    render(<FormField label="Name">{(control) => <Input {...control} />}</FormField>);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'false');
  });
});
