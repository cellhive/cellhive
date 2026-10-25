import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { automationsApi } from '../../../../../lib/api/automations';
import { keys } from '../../../../../lib/query/keys';
import { canonicalJson } from '../../model/draft';
import { chipNameOf, templateSteps, type ValueScope } from '../../model/scope';
import { hasExpressions } from '../../model/values';
import { useBuilderEnv } from '../env';

import { useChipText } from './chips';

import type { ChipLabel } from './TemplateInput';

/**
 * Names of the chips of a template: plain references are named from the
 * schema the builder holds; expressions (`{{ IF(…) }}`) by the server's
 * names form (`validate-template`, form `stored`), asked only when the
 * template has one. Errors of that check show as `#REF` chips.
 */
export function useTemplateChips(
  template: string,
  scope: ValueScope,
): (expression: string, index: number) => ChipLabel {
  const env = useBuilderEnv();
  const text = useChipText();
  const placeholders = useTemplateDisplays(template, scope);
  return useCallback(
    (expression: string, index: number) => {
      const shown = placeholders?.find((item) => item.index === index)?.display;
      const name = chipNameOf(expression, scope, env, shown);
      return { text: text(name), tone: name.tone };
    },
    [placeholders, scope, env, text],
  );
}

/**
 * The names form of each placeholder of `template` (`validate-template`),
 * asked only when it has an expression; `undefined` until known. Index =
 * the placeholder's position among the template's placeholders.
 */
export function useTemplateDisplays(
  template: string,
  scope: ValueScope,
): readonly { readonly index: number; readonly display: string }[] | undefined {
  const env = useBuilderEnv();
  const request = {
    table_id: scope.triggerTableId,
    template,
    form: 'stored' as const,
    trigger_type: scope.triggerType,
    steps: templateSteps(scope),
  };
  const display = useQuery({
    queryKey: keys.automationTemplate(env.base.id, canonicalJson(request)),
    queryFn: ({ signal }) => automationsApi.validateTemplate(env.base.id, request, signal),
    enabled: hasExpressions(template),
    staleTime: 60_000,
  });
  return display.data?.placeholders;
}
