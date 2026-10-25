import { HistoryTimeline } from './HistoryTimeline';

import type { RecordHistoryProps } from '../../../lib/records/detail';

/** The "History" tab of the record panel (FRONTEND §10.3); a lazy chunk given by the route. */
export function RecordHistory(props: RecordHistoryProps) {
  return <HistoryTimeline {...props} />;
}

export default RecordHistory;
