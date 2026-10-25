import { Module } from '@nestjs/common';

import { ExportModule } from '../export/export.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';

import { DashboardDataService } from './dashboard-data.service.js';
import { DashboardExportService } from './dashboard-export.service.js';
import { DashboardWidgetController } from './dashboard-widget.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ValkeyWidgetCacheStore } from './widget-cache-store.js';
import { WidgetQueryLimiter } from './widget-query-limiter.js';

/**
 * Dashboards and widgets: CRUD, layout, duplicate, trash (BACKLOG T805);
 * widget data through `RecordQueryService.widgetData` (T806), cached in
 * Valkey by permission fingerprint and `data_version` (T807; the
 * `dashboard:` channel lives in the realtime module); live filters, filter
 * control values, click-through and widget CSV (T808, with the export slot
 * of the export module). Dashboard share links (T809) read widgets through
 * `DashboardDataService.dataOf` / `optionsOf` and `DashboardExportService.export`
 * with the link's access.
 */
@Module({
  imports: [MetricsModule, ExportModule],
  controllers: [DashboardController, DashboardWidgetController],
  providers: [
    DashboardService,
    DashboardDataService,
    DashboardExportService,
    WidgetQueryLimiter,
    ValkeyWidgetCacheStore,
  ],
  exports: [DashboardService, DashboardDataService, DashboardExportService],
})
export class DashboardModule {}
