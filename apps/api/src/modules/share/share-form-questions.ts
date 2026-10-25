/**
 * Questions a form link hides (CONTRACTS §16A, §17; T321, T410, like Lark):
 * people outside the organization can see neither who is in it nor the
 * records of other tables, so a form link that is not limited to the
 * organization (`audience = public`, with or without `require_login`) leaves
 * out its `user` and `link` questions — `meta` does not list them and
 * `submit` treats them as fields outside the form. `org` links keep them,
 * with the members who can open the base (`GET /shares/:token/members`) and
 * the records the creator reads (`GET /shares/:token/link-candidates/:fieldId`).
 */
export const PRIVATE_QUESTION_TYPES: ReadonlySet<string> = new Set(['user', 'link']);

interface LinkKind {
  readonly target_type: string;
  readonly audience: string;
}

/** Whether the link hides its `user` and `link` questions (see above). */
export function hidesPrivateQuestions(link: LinkKind): boolean {
  return link.target_type === 'form' && link.audience !== 'org';
}

/** Whether a question on a field of `type` is hidden on `link`. */
export function isHiddenQuestion(link: LinkKind, type: string): boolean {
  return hidesPrivateQuestions(link) && PRIVATE_QUESTION_TYPES.has(type);
}
