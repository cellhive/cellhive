import { StepOutput } from '../components/StepOutput';

import { HttpStepDetail } from './http/HttpStepDetail';
import { isHttpStep } from './http/model';

import type { AutomationAction, AutomationRunStepDto } from '@cellhive/contracts';

/** What a step renderer of the run drawer receives (FRONTEND §13.3). */
export interface StepDetailProps {
  readonly step: AutomationRunStepDto;
  readonly action: AutomationAction | null;
  readonly baseId: string;
  readonly userName: (userId: string) => string | null;
}

/**
 * What a step of the run drawer shows under its status and error: a
 * renderer of its own for some kinds of steps (one line each), else the
 * generic output (`StepOutput`).
 */
export function StepDetail({ type, ...props }: StepDetailProps & { readonly type: string | null }) {
  if (isHttpStep(type, props.step)) return <HttpStepDetail {...props} />; // T614: delivery log
  return <StepOutput {...props} />;
}
