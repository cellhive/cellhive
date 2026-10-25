import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../Markdown';
import { parseInline, parseMarkdown, safeHref } from '../parse';

describe('parseMarkdown', () => {
  it.each([
    ['', []],
    ['Hello', [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] }]],
    [
      'a\nb',
      [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: 'a' }, { type: 'break' }, { type: 'text', text: 'b' }],
        },
      ],
    ],
    ['## Title', [{ type: 'heading', level: 2, children: [{ type: 'text', text: 'Title' }] }]],
    [
      '- one\n- two\n\n1. first',
      [
        {
          type: 'list',
          ordered: false,
          items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
        },
        { type: 'list', ordered: true, items: [[{ type: 'text', text: 'first' }]] },
      ],
    ],
  ])('%j', (source, blocks) => {
    expect(parseMarkdown(source)).toEqual(blocks);
  });

  it.each([
    ['**bold**', [{ type: 'strong', children: [{ type: 'text', text: 'bold' }] }]],
    [
      '*it* _it_',
      [
        { type: 'em', children: [{ type: 'text', text: 'it' }] },
        { type: 'text', text: ' ' },
        { type: 'em', children: [{ type: 'text', text: 'it' }] },
      ],
    ],
    ['`x < y`', [{ type: 'code', text: 'x < y' }]],
    [
      '[site](https://a.test)',
      [{ type: 'link', href: 'https://a.test', children: [{ type: 'text', text: 'site' }] }],
    ],
    ['[bad](javascript:alert(1))', [{ type: 'text', text: '[bad](javascript:alert(1))' }]],
    ['2 * 3', [{ type: 'text', text: '2 * 3' }]],
    ['\\*not\\*', [{ type: 'text', text: '*not*' }]],
  ])('inline %j', (source, nodes) => {
    expect(parseInline(source)).toEqual(nodes);
  });

  it.each([
    ['https://a.test', 'https://a.test'],
    ['mailto:a@b.test', 'mailto:a@b.test'],
    ['javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['/relative', null],
  ])('safeHref(%j)', (url, expected) => {
    expect(safeHref(url)).toBe(expected);
  });
});

describe('<Markdown>', () => {
  it('renders elements, never HTML from the source', () => {
    const { container } = render(
      <Markdown source={'<img src=x onerror=alert(1)> **Hi** [docs](https://a.test)'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Hi').tagName).toBe('STRONG');
  });

  it('renders the email syntax of @cellhive/markdown (T529) as elements', () => {
    const { container } = render(
      <Markdown
        source={
          '> quoted ~~old~~\n\n---\n\n```\n<b>raw</b>\n```\n\n| A | B |\n| - | -: |\n| 1 | 2 |'
        }
      />,
    );
    expect(container.querySelector('blockquote')?.textContent).toBe('quoted old');
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('<b>raw</b>');
    expect(container.querySelector('b')).toBeNull();
    expect([...container.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'A',
      'B',
    ]);
    expect(container.querySelectorAll('td')[1]).toHaveClass('text-right');
  });
});
