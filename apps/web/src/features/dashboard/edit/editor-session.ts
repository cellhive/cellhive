import { compactLayout, placeAtBottom } from '@cellhive/contracts';

import { isApiError } from '../../../lib/api/client';

import type {
  DashboardDto,
  DashboardGlobalFilter,
  DashboardTheme,
  WidgetDto,
  WidgetLayout,
  WidgetType,
} from '@cellhive/contracts';

/**
 * The edit session of one dashboard (T812, SPEC §10.1, CONTRACTS §28.1–
 * §28.2): the widgets as the editor shows them, undo/redo (layout, widget
 * settings, widgets added or removed, theme, (T813) global filters — at most 50 steps, gone when
 * the page is left) and the writes to the API, one at a time and in order,
 * each with `If-Match` = the version the session knows. The layout is saved
 * 1 s after the last change (`PUT …/layout`); a `409 VERSION_CONFLICT` (or a
 * `404`: the dashboard or a widget went away) stops the session until the
 * screen reloads it (`reset`).
 *
 * Widgets are known by a `key`: their id, or a local key while they are
 * being created. A widget removed and brought back by "Undo" is created
 * again under a new id, the key stays.
 */

/** Steps kept for undo (BACKLOG T812). */
export const MAX_HISTORY = 50;
/** Debounce of the layout save (BACKLOG T812). */
export const LAYOUT_SAVE_DELAY_MS = 1000;

export interface EditorWidget {
  readonly key: string;
  /** `null` while the widget is being created. */
  readonly id: string | null;
  readonly type: WidgetType;
  readonly title: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly layout: WidgetLayout;
  readonly status: WidgetDto['status'];
  readonly broken_reason: WidgetDto['broken_reason'];
  readonly created_at: string;
  readonly updated_at: string;
}

/** What the settings panel saves: the title and the whole config. */
export interface WidgetContent {
  readonly title: string;
  readonly config: Readonly<Record<string, unknown>>;
}

interface WidgetSnapshot extends WidgetContent {
  readonly key: string;
  readonly type: WidgetType;
  readonly layout: WidgetLayout;
}

/** A widget that followed a filter control, by key (CONTRACTS §28.2). */
interface Follower {
  readonly key: string;
  /** The control was in its `filter_bindings`. */
  readonly bound: boolean;
  /** The control was its `parent_control_id`. */
  readonly child: boolean;
}

/** Places of the widgets by key. */
export type LayoutMap = Readonly<Record<string, WidgetLayout>>;

type Step =
  | { readonly kind: 'layout'; readonly before: LayoutMap; readonly after: LayoutMap }
  | {
      readonly kind: 'content';
      readonly key: string;
      readonly before: WidgetContent;
      readonly after: WidgetContent;
    }
  | {
      readonly kind: 'add' | 'remove';
      readonly widget: WidgetSnapshot;
      /** Places of the other widgets before and after. */
      readonly before: LayoutMap;
      readonly after: LayoutMap;
      /**
       * (filter_control) The widgets that followed the control when it was
       * taken off: brought back with it.
       */
      readonly followers?: readonly Follower[];
    }
  | { readonly kind: 'theme'; readonly before: DashboardTheme; readonly after: DashboardTheme }
  | {
      readonly kind: 'globalFilters';
      readonly before: readonly DashboardGlobalFilter[];
      readonly after: readonly DashboardGlobalFilter[];
    };

export interface EditorState {
  readonly widgets: readonly EditorWidget[];
  readonly theme: DashboardTheme;
  /** (T813) The dashboard's global filters (filter bar). */
  readonly globalFilters: readonly DashboardGlobalFilter[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** A save is waiting or running. */
  readonly saving: boolean;
}

/** The API calls of the editor (`lib/api/dashboards.ts`; a fake in tests). */
export interface EditorApi {
  putLayout(
    dashboardId: string,
    layout: Record<string, WidgetLayout>,
    version: number,
  ): Promise<DashboardDto>;
  createWidget(
    dashboardId: string,
    body: {
      type: WidgetType;
      title: string;
      config: Record<string, unknown>;
      layout: WidgetLayout;
    },
    version: number,
  ): Promise<WidgetDto>;
  updateWidget(
    widgetId: string,
    body: { title: string; config: Record<string, unknown> },
    version: number,
  ): Promise<WidgetDto>;
  removeWidget(widgetId: string, version: number): Promise<void>;
  updateTheme(dashboardId: string, theme: DashboardTheme, version: number): Promise<DashboardDto>;
  /** (T813) `PATCH /dashboards/:id { global_filters }`. */
  updateGlobalFilters(
    dashboardId: string,
    globalFilters: readonly DashboardGlobalFilter[],
    version: number,
  ): Promise<DashboardDto>;
}

export interface EditorEvents {
  /** Someone else changed the dashboard (`409`), or it or a widget went away (`404`). */
  readonly onConflict: () => void;
  /** Any other failed save (shown as a toast). */
  readonly onError: (error: unknown) => void;
}

export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function fromDto(widget: WidgetDto, key: string = widget.id): EditorWidget {
  return {
    key,
    id: widget.id,
    type: widget.type,
    title: widget.title,
    config: widget.config,
    layout: widget.layout,
    status: widget.status,
    broken_reason: widget.broken_reason,
    created_at: widget.created_at,
    updated_at: widget.updated_at,
  };
}

function layoutMapOf(widgets: readonly EditorWidget[], except?: string): LayoutMap {
  const map: Record<string, WidgetLayout> = {};
  for (const widget of widgets) if (widget.key !== except) map[widget.key] = widget.layout;
  return map;
}

function sameRect(a: WidgetLayout | undefined, b: WidgetLayout | undefined): boolean {
  return (
    a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  );
}

function sameLayouts(a: LayoutMap, b: LayoutMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameRect(a[key], b[key]));
}

function isConflict(error: unknown): boolean {
  return isApiError(error) && (error.status === 409 || error.status === 404);
}

/**
 * A config as it may be saved now: filter controls that no longer exist are
 * dropped from `filter_bindings`, a missing parent control becomes `null`
 * (the server unbinds them when a control is deleted, CONTRACTS §28.2).
 */
export function liveConfig(
  type: WidgetType,
  config: Readonly<Record<string, unknown>>,
  controlIds: ReadonlySet<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const bindings = next['filter_bindings'];
  if (Array.isArray(bindings)) {
    next['filter_bindings'] = bindings.filter(
      (id): id is string => typeof id === 'string' && controlIds.has(id),
    );
  }
  if (type === 'filter_control') {
    const parent = next['parent_control_id'];
    if (typeof parent === 'string' && !controlIds.has(parent)) next['parent_control_id'] = null;
  }
  return next;
}

export class DashboardEditorSession {
  private widgets: readonly EditorWidget[];
  private theme: DashboardTheme;
  private globalFilters: readonly DashboardGlobalFilter[];
  private version: number;
  private past: Step[] = [];
  private future: Step[] = [];
  private chain: Promise<void> = Promise.resolve();
  private busy = 0;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by `reset`: queued writes of an older generation are dropped. */
  private generation = 0;
  private stopped = false;
  private nextKey = 0;
  /** Ids of widgets taken off the screen whose delete is queued (by key). */
  private readonly removedIds = new Map<string, string>();
  private snapshot: EditorState;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly dashboardId: string,
    dashboard: DashboardDto,
    private readonly api: EditorApi,
    private events: EditorEvents,
    private readonly layoutDelay = LAYOUT_SAVE_DELAY_MS,
  ) {
    this.widgets = dashboard.widgets.map((widget) => fromDto(widget));
    this.theme = dashboard.theme;
    this.globalFilters = dashboard.global_filters;
    this.version = dashboard.version;
    this.snapshot = this.buildSnapshot();
  }

  /** Replaces the callbacks (the page's translations and query client change). */
  setEvents(events: EditorEvents): void {
    this.events = events;
  }

  // --- Store ----------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EditorState => this.snapshot;

  /** The dashboard version this session writes against. */
  get currentVersion(): number {
    return this.version;
  }

  /** Nothing waiting to be saved and no write running. */
  get idle(): boolean {
    return this.busy === 0 && this.layoutTimer === null;
  }

  private buildSnapshot(): EditorState {
    return {
      widgets: this.widgets,
      theme: this.theme,
      globalFilters: this.globalFilters,
      canUndo: this.past.length > 0 && !this.stopped,
      canRedo: this.future.length > 0 && !this.stopped,
      saving: this.busy > 0 || this.layoutTimer !== null,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /** Starts over from the dashboard as the server has it now (after a conflict). */
  reset(dashboard: DashboardDto): void {
    this.clearTimer();
    this.generation += 1;
    this.chain = Promise.resolve();
    this.busy = 0;
    this.stopped = false;
    this.past = [];
    this.future = [];
    this.widgets = dashboard.widgets.map((widget) => fromDto(widget));
    this.theme = dashboard.theme;
    this.globalFilters = dashboard.global_filters;
    this.version = dashboard.version;
    this.emit();
  }

  /** Saves what is waiting now (Done, leaving the page). */
  flush(): Promise<void> {
    if (this.layoutTimer !== null) {
      this.clearTimer();
      void this.enqueue(() => this.saveLayout());
    }
    return this.chain;
  }

  // --- Writes ---------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.layoutTimer !== null) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    this.busy += 1;
    this.emit();
    const run = this.chain.then(async () => {
      try {
        // Dropped (reset, or stopped by a conflict): still counted down below.
        if (generation !== this.generation || this.stopped) return;
        await task();
      } catch (error) {
        if (generation === this.generation) this.fail(error);
      } finally {
        if (generation === this.generation) {
          this.busy -= 1;
          this.emit();
        }
      }
    });
    this.chain = run;
    return run;
  }

  private fail(error: unknown): void {
    if (isConflict(error)) {
      this.stopped = true;
      this.clearTimer();
      this.emit();
      this.events.onConflict();
      return;
    }
    this.events.onError(error);
  }

  private scheduleLayoutSave(): void {
    this.clearTimer();
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      void this.enqueue(() => this.saveLayout());
    }, this.layoutDelay);
    this.emit();
  }

  /** Saves the layout at once (before a create that needs the space). */
  private saveLayoutNow(): void {
    this.clearTimer();
    void this.enqueue(() => this.saveLayout());
  }

  private async saveLayout(): Promise<void> {
    const sent: Record<string, WidgetLayout> = {};
    for (const widget of this.widgets) if (widget.id !== null) sent[widget.id] = widget.layout;
    if (Object.keys(sent).length === 0) return;
    const saved = await this.api.putLayout(this.dashboardId, sent, this.version);
    this.version = saved.version;
    // The server stores the vertically compacted layout; take it when nothing moved since.
    const byId = new Map<string, WidgetLayout>(
      saved.widgets.map((widget) => [widget.id, widget.layout]),
    );
    if (
      this.layoutTimer === null &&
      this.widgets.every((widget) => widget.id === null || sameRect(sent[widget.id], widget.layout))
    ) {
      this.widgets = this.widgets.map((widget) => {
        const layout = widget.id === null ? undefined : byId.get(widget.id);
        return layout === undefined || sameRect(layout, widget.layout)
          ? widget
          : { ...widget, layout };
      });
    }
  }

  private controlIds(): Set<string> {
    return new Set(
      this.widgets
        .filter((widget) => widget.type === 'filter_control' && widget.id !== null)
        .map((widget) => widget.id as string),
    );
  }

  private replace(key: string, patch: Partial<EditorWidget>): void {
    this.widgets = this.widgets.map((widget) =>
      widget.key === key ? { ...widget, ...patch } : widget,
    );
  }

  private find(key: string): EditorWidget | undefined {
    return this.widgets.find((widget) => widget.key === key);
  }

  private create(snapshot: WidgetSnapshot, followers: readonly Follower[] = []): void {
    void this.enqueue(async () => {
      const current = this.find(snapshot.key);
      if (current === undefined) return;
      const created = await this.api
        .createWidget(
          this.dashboardId,
          {
            type: current.type,
            title: current.title,
            config: liveConfig(current.type, current.config, this.controlIds()),
            layout: current.layout,
          },
          this.version,
        )
        .catch((error: unknown) => {
          if (!isConflict(error)) {
            // Not created: it leaves the screen (the toast says why).
            this.widgets = this.widgets.filter((widget) => widget.key !== snapshot.key);
          }
          throw error;
        });
      this.version += 1;
      const latest = this.find(snapshot.key);
      if (latest === undefined) {
        // Removed while it was being created: delete it before the next layout save.
        this.removedIds.set(snapshot.key, created.id);
        this.delete(snapshot.key);
        return;
      }
      this.replace(snapshot.key, {
        ...fromDto(created, snapshot.key),
        // Moved while it was being created: the layout save that follows has the place.
        layout: latest.layout,
      });
      if (created.type === 'filter_control') await this.rebind(created.id, followers);
    });
  }

  /**
   * Binds the widgets that followed a filter control again, to the control
   * created anew under `controlId` (undo of its removal, redo of its addition).
   */
  private async rebind(controlId: string, followers: readonly Follower[]): Promise<void> {
    for (const follower of followers) {
      const widget = this.find(follower.key);
      if (widget === undefined) continue;
      const bindings = widget.config['filter_bindings'];
      const list: readonly unknown[] = Array.isArray(bindings) ? bindings : [];
      const bind = follower.bound && !list.includes(controlId);
      const parent = follower.child && widget.config['parent_control_id'] == null;
      if (!bind && !parent) continue;
      const config = {
        ...widget.config,
        ...(bind ? { filter_bindings: [...list, controlId] } : {}),
        ...(parent ? { parent_control_id: controlId } : {}),
      };
      this.replace(follower.key, { config });
      // Not created yet: its queued create sends the config as it is now.
      if (widget.id === null) continue;
      const saved = await this.api.updateWidget(
        widget.id,
        { title: widget.title, config: liveConfig(widget.type, config, this.controlIds()) },
        this.version,
      );
      this.version += 1;
      const latest = this.find(follower.key);
      this.replace(follower.key, {
        ...fromDto(saved, follower.key),
        layout: latest?.layout ?? saved.layout,
      });
    }
  }

  private delete(key: string): void {
    void this.enqueue(async () => {
      const id = this.removedIds.get(key);
      if (id === undefined) return;
      this.removedIds.delete(key);
      await this.api.removeWidget(id, this.version);
      this.version += 1;
    });
  }

  private putContent(key: string, content: WidgetContent): Promise<SaveResult> {
    let result: SaveResult = { ok: false, error: null };
    return this.enqueue(async () => {
      const widget = this.find(key);
      if (widget?.id === null || widget === undefined) {
        result = { ok: false, error: null };
        return;
      }
      try {
        const saved = await this.api.updateWidget(
          widget.id,
          {
            title: content.title,
            config: liveConfig(widget.type, content.config, this.controlIds()),
          },
          this.version,
        );
        this.version += 1;
        const latest = this.find(key);
        this.replace(key, { ...fromDto(saved, key), layout: latest?.layout ?? saved.layout });
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error };
        // Field errors go back to the panel; conflicts and the rest stop or toast.
        if (isConflict(error)) throw error;
        if (!(isApiError(error) && error.status === 422)) throw error;
      }
    }).then(() => result);
  }

  // --- Editing --------------------------------------------------------------------------

  private record(step: Step): void {
    this.past = [...this.past, step].slice(-MAX_HISTORY);
    this.future = [];
  }

  /** The current places by widget key. */
  layout(): LayoutMap {
    return layoutMapOf(this.widgets);
  }

  private applyLayout(map: LayoutMap): boolean {
    let changed = false;
    this.widgets = this.widgets.map((widget) => {
      const layout = map[widget.key];
      if (layout === undefined || sameRect(layout, widget.layout)) return widget;
      changed = true;
      return { ...widget, layout };
    });
    return changed;
  }

  /** Shows places without saving them (a keyboard move in progress). */
  preview(map: LayoutMap): void {
    if (this.applyLayout(map)) this.emit();
  }

  /**
   * Keeps a new layout (drag, resize, a keyboard move confirmed): one undo
   * step from `before`, saved after the debounce.
   */
  commitLayout(before: LayoutMap, after: LayoutMap): void {
    if (this.stopped) return;
    this.applyLayout(after);
    if (sameLayouts(before, this.layout())) {
      this.emit();
      return;
    }
    this.record({ kind: 'layout', before, after: this.layout() });
    this.scheduleLayoutSave();
  }

  /** Adds a widget below every other one; returns its key (`null`: the session is stopped). */
  addWidget(
    type: WidgetType,
    content: WidgetContent,
    size: { readonly w: number; readonly h: number },
  ): string | null {
    if (this.stopped) return null;
    this.nextKey += 1;
    const key = `new-${String(this.nextKey)}`;
    const layout = placeAtBottom(
      this.widgets.map((widget) => widget.layout),
      size.w,
      size.h,
    );
    const now = new Date().toISOString();
    const widget: EditorWidget = {
      key,
      id: null,
      type,
      title: content.title,
      config: content.config,
      layout,
      status: 'ok',
      broken_reason: null,
      created_at: now,
      updated_at: now,
    };
    const before = this.layout();
    this.widgets = [...this.widgets, widget];
    this.record({ kind: 'add', widget: { key, type, ...content, layout }, before, after: before });
    this.create({ key, type, ...content, layout });
    this.emit();
    return key;
  }

  /** A copy of a widget (title, settings, size) below every other one. */
  duplicate(key: string): string | null {
    const source = this.find(key);
    if (source === undefined || this.stopped) return null;
    return this.addWidget(
      source.type,
      { title: source.title, config: source.config },
      { w: source.layout.w, h: source.layout.h },
    );
  }

  /** Removes a widget; the others move up into its space. */
  remove(key: string): void {
    const widget = this.find(key);
    if (widget === undefined || this.stopped) return;
    const before = this.layout();
    const followers = this.takeOff(widget);
    this.record({
      kind: 'remove',
      widget: this.snapshotOf(widget),
      before: omit(before, key),
      after: this.layout(),
      followers,
    });
    this.emit();
  }

  private snapshotOf(widget: EditorWidget): WidgetSnapshot {
    return {
      key: widget.key,
      type: widget.type,
      title: widget.title,
      config: widget.config,
      layout: widget.layout,
    };
  }

  /**
   * Takes a widget off the screen, deletes it and compacts the rest; returns
   * the widgets that followed it (a filter control) and stop following it.
   */
  private takeOff(widget: EditorWidget): Follower[] {
    const followers: Follower[] = [];
    this.widgets = this.widgets.filter((item) => item.key !== widget.key);
    if (widget.id !== null) {
      this.removedIds.set(widget.key, widget.id);
      if (widget.type === 'filter_control') {
        // Mirror the server: widgets that followed the control stop following it.
        const removed = widget.id;
        this.widgets = this.widgets.map((item) => {
          const bindings = item.config['filter_bindings'];
          const parent = item.config['parent_control_id'];
          const bound = Array.isArray(bindings) && bindings.includes(removed);
          const child = parent === removed;
          if (!bound && !child) return item;
          followers.push({ key: item.key, bound, child });
          return {
            ...item,
            config: {
              ...item.config,
              ...(Array.isArray(bindings)
                ? { filter_bindings: bindings.filter((id) => id !== removed) }
                : {}),
              ...(parent === removed ? { parent_control_id: null } : {}),
            },
          };
        });
      }
      this.delete(widget.key);
    }
    // Not created yet: the queued create finds nothing and skips.
    const compacted = compactLayout(this.widgets.map((item) => ({ id: item.key, ...item.layout })));
    const map: Record<string, WidgetLayout> = {};
    for (const item of compacted) map[item.id] = { x: item.x, y: item.y, w: item.w, h: item.h };
    if (this.applyLayout(map)) this.scheduleLayoutSave();
    return followers;
  }

  /** Puts a widget back (undo of a removal, redo of an addition). */
  private putBack(
    snapshot: WidgetSnapshot,
    others: LayoutMap,
    followers: readonly Follower[] = [],
  ): void {
    if (this.applyLayout(others)) this.saveLayoutNow();
    const now = new Date().toISOString();
    this.widgets = [
      ...this.widgets,
      {
        key: snapshot.key,
        id: null,
        type: snapshot.type,
        title: snapshot.title,
        config: snapshot.config,
        layout: snapshot.layout,
        status: 'ok',
        broken_reason: null,
        created_at: now,
        updated_at: now,
      },
    ];
    this.create(snapshot, followers);
  }

  /**
   * Saves a widget's title and settings. One undo step when it is saved; a
   * `422` comes back to the panel (the fields it names), nothing changes.
   */
  async saveContent(key: string, content: WidgetContent): Promise<SaveResult> {
    const widget = this.find(key);
    if (widget === undefined || this.stopped) return { ok: false, error: null };
    const before: WidgetContent = { title: widget.title, config: widget.config };
    const result = await this.putContent(key, content);
    if (result.ok) {
      const saved = this.find(key);
      this.record({
        kind: 'content',
        key,
        before,
        after: saved === undefined ? content : { title: saved.title, config: saved.config },
      });
      this.emit();
    }
    return result;
  }

  setTheme(theme: DashboardTheme): void {
    if (this.stopped) return;
    const before = this.theme;
    this.record({ kind: 'theme', before, after: theme });
    this.applyTheme(theme);
  }

  private applyTheme(theme: DashboardTheme): void {
    this.theme = theme;
    void this.enqueue(async () => {
      const saved = await this.api.updateTheme(this.dashboardId, theme, this.version);
      this.version = saved.version;
    });
    this.emit();
  }

  /** (T813) Replaces the global filters (one undo step), saved at once. */
  setGlobalFilters(globalFilters: readonly DashboardGlobalFilter[]): void {
    if (this.stopped) return;
    const before = this.globalFilters;
    this.record({ kind: 'globalFilters', before, after: globalFilters });
    this.applyGlobalFilters(globalFilters);
  }

  private applyGlobalFilters(globalFilters: readonly DashboardGlobalFilter[]): void {
    this.globalFilters = globalFilters;
    void this.enqueue(async () => {
      const saved = await this.api.updateGlobalFilters(
        this.dashboardId,
        globalFilters,
        this.version,
      );
      this.version = saved.version;
    });
    this.emit();
  }

  // --- Undo / redo ----------------------------------------------------------------------

  undo(): void {
    const step = this.past.at(-1);
    if (step === undefined || this.stopped) return;
    this.past = this.past.slice(0, -1);
    this.future = [...this.future, this.apply(step, 'back')];
    this.emit();
  }

  redo(): void {
    const step = this.future.at(-1);
    if (step === undefined || this.stopped) return;
    this.future = this.future.slice(0, -1);
    this.past = [...this.past, this.apply(step, 'forward')];
    this.emit();
  }

  /** Applies a step one way; returns the step to keep on the other stack. */
  private apply(step: Step, way: 'back' | 'forward'): Step {
    switch (step.kind) {
      case 'layout':
        if (this.applyLayout(way === 'back' ? step.before : step.after)) {
          this.scheduleLayoutSave();
        }
        return step;
      case 'content': {
        const content = way === 'back' ? step.before : step.after;
        this.replace(step.key, content);
        void this.putContent(step.key, content).then((result) => {
          if (!result.ok && result.error !== null) this.events.onError(result.error);
        });
        return step;
      }
      case 'theme':
        this.applyTheme(way === 'back' ? step.before : step.after);
        return step;
      case 'globalFilters':
        this.applyGlobalFilters(way === 'back' ? step.before : step.after);
        return step;
      case 'add':
      case 'remove': {
        const takesOff = (step.kind === 'add') === (way === 'back');
        if (takesOff) {
          const widget = this.find(step.widget.key);
          if (widget === undefined) return step;
          const snapshot = this.snapshotOf(widget);
          const followers = this.takeOff(widget);
          if (this.applyLayout(way === 'back' ? step.before : step.after)) {
            this.scheduleLayoutSave();
          }
          return { ...step, widget: snapshot, followers };
        }
        this.putBack(step.widget, way === 'back' ? step.before : step.after, step.followers);
        return step;
      }
    }
  }

  /** Stops pending timers (the page is left: what waits is saved first). */
  dispose(): void {
    void this.flush();
  }
}

function omit(map: LayoutMap, key: string): LayoutMap {
  return Object.fromEntries(Object.entries(map).filter(([id]) => id !== key));
}
