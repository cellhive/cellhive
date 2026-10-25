/**
 * Telegram HTML after a cut (BACKLOG T516): a text cut at 4,096 characters
 * may end inside a tag (`<a href="ht…`) or an entity (`&am…`), or leave tags
 * open — the Bot API refuses such a message (`can't parse entities`). The
 * unfinished tail is dropped and the open tags are closed, innermost first.
 * Only applied to a text that was cut: a whole template is sent as written.
 */

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^<>]*>/gu;
const ELLIPSIS = '…';

export function closeCutTelegramHtml(text: string): string {
  let body = text;
  const ellipsis = body.endsWith(ELLIPSIS);
  if (ellipsis) body = body.slice(0, -ELLIPSIS.length);
  // An unfinished tag: `<` after the last `>`.
  const open = body.lastIndexOf('<');
  if (open > body.lastIndexOf('>')) body = body.slice(0, open);
  // An unfinished entity: `&` followed by entity characters up to the end.
  body = body.replace(/&#?[A-Za-z0-9]*$/u, '');
  const stack: string[] = [];
  for (const match of body.matchAll(TAG)) {
    const name = (match[2] ?? '').toLowerCase();
    if (match[1] === '/') {
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
    } else {
      stack.push(name);
    }
  }
  const closing = stack
    .reverse()
    .map((name) => `</${name}>`)
    .join('');
  return `${body}${ellipsis ? ELLIPSIS : ''}${closing}`;
}
