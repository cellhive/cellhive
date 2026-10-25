import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { automationsApi } from '../../../../../lib/api/automations';
import { isApiError } from '../../../../../lib/api/client';
import { keys } from '../../../../../lib/query/keys';
import { canonicalJson } from '../../model/draft';

import type { SendEmailConfig } from '@cellhive/contracts';

/** Waits until `value` stops changing for `delay` ms (typing in the editor). */
export function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  // `key` stands for `value` (a new object on every edit of the draft).
  const key = canonicalJson(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(latest.current);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [key, delay]);
  return settled;
}

/** Whether the contract accepts the draft as a preview body (one recipient, a subject). */
export function previewable(config: SendEmailConfig): boolean {
  return config.to.length > 0 && config.subject.template.trim() !== '';
}

export interface EmailPreviewInput {
  /** The saved automation (a preview needs one: CONTRACTS §21). */
  readonly automationId: string | null;
  readonly actionId: string;
  readonly config: SendEmailConfig;
  /** The sample record (`null` for a trigger without record). */
  readonly recordId: string | null;
  /** The trigger has a record but none is chosen yet. */
  readonly waitingForRecord: boolean;
}

/**
 * The email of the step rendered by the server on the sample record, with
 * the editor's own permissions (`POST …/email-preview`, CONTRACTS §21): the
 * draft is sent as it is (debounced), so what the preview shows is what
 * saving would send; the previous result stays while the next one loads.
 */
export function useEmailPreview({
  automationId,
  actionId,
  config,
  recordId,
  waitingForRecord,
}: EmailPreviewInput) {
  const draft = useSettled(config, 500);
  const request = { record_id: recordId, draft };
  const ready = automationId !== null && !waitingForRecord && previewable(draft);
  return useQuery({
    queryKey: keys.automationEmailPreview(automationId ?? '', actionId, canonicalJson(request)),
    queryFn: ({ signal }) =>
      automationsApi.emailPreview(automationId ?? '', actionId, request, signal),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 1,
  });
}
