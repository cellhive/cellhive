import { lazy } from 'react';

import type { RecordDetailComponents } from '../lib/records/detail';

/**
 * (T812) The dashboard page (`features/dashboard`) gets the widget filter
 * editor of its edit mode — the view filter builder over a table's fields
 * (`features/view`) — from here (FRONTEND §1.2). The builder is a lazy
 * chunk loaded when a widget's settings open: view mode never downloads it.
 * (T813) Also the record panel of the grid (`features/record`, lazy): a
 * record of a click-through opens in it.
 */
const RecordFilterEditor = lazy(() =>
  import('../features/view/toolbar/RecordFilterEditor').then((module) => ({
    default: module.RecordFilterEditor,
  })),
);

/**
 * (T814) "Share" of the dashboard (`features/share/manage`): the button is a
 * small lazy chunk, the dialog another one loaded when it opens.
 */
const DashboardShareButton = lazy(
  () => import('../features/share/manage/components/DashboardShareButton'),
);

export async function loadDashboardRoute(recordDetail?: RecordDetailComponents) {
  const { DashboardPage } = await import('../features/dashboard/view/DashboardPage');
  return {
    Component: function DashboardRoute() {
      return (
        <DashboardPage
          FilterEditor={RecordFilterEditor}
          RecordDetail={recordDetail}
          ShareAction={DashboardShareButton}
        />
      );
    },
  };
}
