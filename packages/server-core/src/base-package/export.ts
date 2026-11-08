import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

import {
  BASE_EXPORT_PHASES,
  basePackageProgress,
  isId,
  type AutomationDefinition,
  type BaseExportPhase,
  type BasePackageCounts,
  type BasePackageDetachedKind,
  type Id,
} from '@cellhive/contracts';

import { emailAssetReferencesOf } from '../automation/duplicate/duplicate.js';

import {
  ATTACHMENTS_ENTRY,
  classifyEntry,
  dataEntry,
  fileEntry,
  isAlreadyCompressed,
  linksEntry,
  SCHEMA_ENTRIES,
} from './entries.js';
import { deflateStaysWithinRatio } from './limits.js';
import { PackageLocation, PackageRewriter, PackageSchemaCatalog } from './references.js';
import { PackageUserEmails } from './users.js';
import { BasePackageWriter } from './writer.js';

import type { BasePackageLimits } from './limits.js';
import type {
  PackageDashboard,
  PackageFile,
  PackageRole,
  PackageTable,
  PackageView,
} from './manifest.js';
import type { StoredRecordOutput } from '../records/types.js';

/**
 * Writing a whole base into a `.chbase` package (ADR-24 §1 and its 2026-11
 * amendment, CONTRACTS §12.2): the orchestration of the `base.export` job,
 * pure apart from stream I/O — what the base holds comes from a
 * {@link BaseExportSource} (the database and the object storage in
 * `export-source.ts`, fakes in tests), the package goes through
 * {@link BasePackageWriter} into a new file.
 *
 * Order: the schema is loaded first (phase `schema`); the records of every
 * table are streamed in storage form into `data/<tbl>.ndjson`, their link
 * cells spooled to temporary files (`records`); the junction rows whose two
 * records made it into the package become `links/<fld>.ndjson` (`links`);
 * the files of cells, form covers and email images are streamed from
 * storage (`files`); then the schema entries are written, rewritten against
 * what the package really holds — a reference to a record, file, field…
 * the package does not hold (in the trash, deleted meanwhile) is left out
 * where it can be and listed in `missing_ids` otherwise — and the manifest
 * last. Users are emails everywhere; secrets, sending identities, groups
 * and incoming webhooks of automations are only names in `detached`.
 *
 * Never in a package: trashed tables, fields or records, personal views
 * (counted in `skipped.personal_views`), formula/lookup/button values,
 * share links, tokens, secret values, members, role assignments, audit,
 * history, events, runs.
 */

/** A table as the source gives it: stored options, users as ids. */
export type ExportTable = PackageTable;

/** An automation of the base (stored definition, users and secrets as ids). */
export interface ExportAutomation {
  readonly id: Id<'aut'>;
  readonly name: string;
  readonly description: string;
  readonly definition: Record<string, unknown>;
}

/** A file of storage the package may hold (`object` is the source's handle, never written). */
interface ExportFileBase {
  readonly id: Id<'att'>;
  readonly filename: string;
  readonly mime: string;
  readonly object: string;
}

/** A file of an attachment cell. */
export interface ExportCellFile extends ExportFileBase {
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly recordId: Id<'rec'>;
}

/** The cover image of a form view. */
export interface ExportFormCover extends ExportFileBase {
  readonly tableId: Id<'tbl'>;
  readonly viewId: Id<'viw'>;
}

/** An image of the body of an automation email. */
export interface ExportEmailAsset extends ExportFileBase {
  readonly width: number | null;
  readonly height: number | null;
}

/** What the base is made of, read once at the start. */
export interface BaseExportSchema {
  readonly base: {
    readonly id: Id<'bse'>;
    readonly name: string;
    readonly description: string | null;
    readonly icon: string | null;
    readonly settings: Record<string, unknown>;
  };
  /** Tables outside the trash with their fields outside the trash, in display order. */
  readonly tables: readonly ExportTable[];
  /** Shared views of those tables. */
  readonly views: readonly PackageView[];
  /** Personal views of those tables: never exported, only counted. */
  readonly personalViews: number;
  /** Dashboards outside the trash with their widgets. */
  readonly dashboards: readonly PackageDashboard[];
  /** Automations not deleted. */
  readonly automations: readonly ExportAutomation[];
  /** Custom roles (system roles exist in every base; assignments are never exported). */
  readonly roles: readonly PackageRole[];
}

/** The records of one table, opened (`rowCount` counted then). */
export interface ExportRecordStream {
  readonly rowCount: number;
  records(): AsyncIterable<readonly StoredRecordOutput[]>;
}

/** A secret, identity, group or incoming webhook an automation names. */
export interface ExportDetachedRef {
  readonly kind: BasePackageDetachedKind;
  readonly id: string;
}

export interface BaseExportSource {
  schema(): Promise<BaseExportSchema>;
  /** User id → email of the organization's members (others become placeholders). */
  memberEmails(): Promise<ReadonlyMap<string, string>>;
  /** The live records of a table, in storage form, in creation order. */
  openRecords(tableId: Id<'tbl'>): Promise<ExportRecordStream>;
  /** The files of `ids` attached to cells of `tableId` (ready, not detached). */
  cellFiles(tableId: Id<'tbl'>, ids: readonly Id<'att'>[]): Promise<readonly ExportCellFile[]>;
  /** The cover images among `ids` of form views of the base (ready). */
  formCovers(ids: readonly Id<'att'>[]): Promise<readonly ExportFormCover[]>;
  /** The email images among `ids` (ready). */
  emailAssets(ids: readonly Id<'att'>[]): Promise<readonly ExportEmailAsset[]>;
  /** Names of what automations name; an id with no name is left out. */
  detachedNames(refs: readonly ExportDetachedRef[]): Promise<ReadonlyMap<string, string>>;
  /** The content of a file; fails when the object is missing. */
  openFile(object: string): Promise<Readable>;
}

export interface ExportBasePackageOptions {
  /** The package file to create (`wx`: must not exist). */
  readonly path: string;
  /** Directory for the spools of link cells (the caller removes it). */
  readonly tempDir: string;
  readonly limits: BasePackageLimits;
  readonly appVersion: string;
  readonly exportedAt: Date;
  readonly exportedByEmail: string | null;
  /** Progress of the job in [0; 0.97] (the upload of the file is the caller's last phase). */
  readonly onProgress?: (progress: number, phase: BaseExportPhase) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

export interface ExportedBasePackage {
  /** Bytes of the package file. */
  readonly bytes: number;
  /** Uncompressed bytes of its entries (the compression ratio the reader caps). */
  readonly uncompressedBytes: number;
  readonly counts: BasePackageCounts;
  readonly skippedPersonalViews: number;
}

/** Records between two progress reports, at least. */
const PROGRESS_STEP = 0.01;

type PackageFileOut = PackageFile;

interface PendingFile {
  readonly source: ExportFileBase;
  readonly meta: (written: { size: number; sha256: string }) => PackageFileOut;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Attachment ids of the stored value of an attachment cell. */
function attachmentIdsOf(value: unknown): Id<'att'>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecordObject(item) && isId('att', item['id']) ? [item['id']] : [],
  );
}

/** Appends JSON lines to a spool file, waiting when it is busy. */
class LineSpool {
  private readonly stream: WriteStream;
  lines = 0;

  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  }

  async write(value: unknown): Promise<void> {
    this.lines += 1;
    if (!this.stream.write(`${JSON.stringify(value)}\n`)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    if (this.stream.closed) return;
    const closed = once(this.stream, 'close');
    this.stream.end();
    await closed;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

/** Reads back the JSON lines of a spool file. */
async function* readSpool(path: string): AsyncGenerator {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line !== '') yield JSON.parse(line) as unknown;
    }
  } finally {
    lines.close();
  }
}

/** Ids the package holds, and the resolver of the export walk over them. */
class ExportedIds {
  readonly objects = new Set<string>();
  /** Option ids by select field. */
  readonly options = new Map<string, Set<string>>();
  /** Records written to `data/*` (a record named elsewhere must be one of them). */
  readonly records = new Set<string>();
  /** Files of the package by id. */
  readonly files = new Map<string, PendingFile>();

  resolve(id: string, owner?: string): string | null {
    if (isId('opt', id)) {
      return owner !== undefined && this.options.get(owner)?.has(id) === true ? id : null;
    }
    if (isId('rec', id)) return this.records.has(id) ? id : null;
    if (isId('att', id)) return this.files.has(id) ? id : null;
    return this.objects.has(id) ? id : null;
  }
}

/** Progress reports of the phases, a report at least every {@link PROGRESS_STEP}. */
class Progress {
  private last = -1;

  constructor(private readonly report: ExportBasePackageOptions['onProgress']) {}

  async at(phase: BaseExportPhase, done: number, total: number): Promise<void> {
    if (this.report === undefined) return;
    const progress = basePackageProgress(BASE_EXPORT_PHASES, phase, done, total);
    if (progress - this.last < PROGRESS_STEP && done < total) return;
    this.last = progress;
    await this.report(progress, phase);
  }
}

/**
 * Writes the base of `source` as a package at `options.path` (see the top
 * of this file). Fails with the writer's errors (`VALIDATION_FAILED`
 * `PACKAGE_TOO_LARGE`, `INVALID_PACKAGE` `ARCHIVE_LIMIT_EXCEEDED`) or the
 * source's; the caller removes the file and `tempDir` in every case.
 */
export async function exportBasePackage(
  source: BaseExportSource,
  options: ExportBasePackageOptions,
): Promise<ExportedBasePackage> {
  const progress = new Progress(options.onProgress);
  const signal = options.signal;
  const writer = await BasePackageWriter.create(options.path, {
    limits: options.limits,
    mtime: options.exportedAt,
  });
  const spools = new Map<string, LineSpool>();
  try {
    let uncompressed = 0;
    const written = (entry: { readonly size: number }) => {
      uncompressed += entry.size;
    };

    // --- schema ---------------------------------------------------------------------
    await progress.at('schema', 0, 1);
    const schema = await source.schema();
    const ids = new ExportedIds();
    for (const table of schema.tables) {
      ids.objects.add(table.id);
      for (const field of table.fields) {
        ids.objects.add(field.id);
        if (field.type === 'select' && Array.isArray(field.options['options'])) {
          const own = new Set<string>();
          for (const option of field.options['options'] as unknown[]) {
            if (isRecordObject(option) && isId('opt', option['id'])) own.add(option['id']);
          }
          ids.options.set(field.id, own);
        }
      }
    }
    for (const view of schema.views) {
      ids.objects.add(view.id);
      for (const rule of Array.isArray(view.config['color_rules'])
        ? (view.config['color_rules'] as unknown[])
        : []) {
        if (isRecordObject(rule) && isId('clr', rule['id'])) ids.objects.add(rule['id']);
      }
    }
    for (const dashboard of schema.dashboards) {
      ids.objects.add(dashboard.id);
      for (const widget of dashboard.widgets) ids.objects.add(widget.id);
    }
    for (const automation of schema.automations) ids.objects.add(automation.id);
    for (const role of schema.roles) ids.objects.add(role.id);

    // Files named by the schema: form covers and email images.
    const coverIds = schema.views.flatMap((view) => {
      const form = view.config['form'];
      const id = isRecordObject(form) ? form['cover_attachment_id'] : undefined;
      return view.type === 'form' && isId('att', id) ? [id] : [];
    });
    const coverViews = new Map(
      schema.views.flatMap((view) => {
        const form = view.config['form'];
        const id = isRecordObject(form) ? form['cover_attachment_id'] : undefined;
        return isId('att', id) ? [[id, view] as const] : [];
      }),
    );
    for (const cover of await source.formCovers(coverIds)) {
      const view = coverViews.get(cover.id);
      if (view === undefined || view.id !== cover.viewId) continue;
      ids.files.set(cover.id, {
        source: cover,
        meta: (file) => ({
          id: cover.id,
          kind: 'form_cover',
          filename: cover.filename,
          mime: cover.mime,
          size: file.size,
          sha256: file.sha256,
          table_id: cover.tableId,
          view_id: cover.viewId,
        }),
      });
    }
    const assetOwners = new Map<string, Id<'aut'>>();
    for (const automation of schema.automations) {
      let references: { readonly assetId: Id<'att'> }[] = [];
      try {
        references = emailAssetReferencesOf(
          automation.definition as unknown as AutomationDefinition,
        );
      } catch {
        // A definition that cannot be read has no image the package could hold.
      }
      for (const reference of references) {
        if (!assetOwners.has(reference.assetId)) {
          assetOwners.set(reference.assetId, automation.id);
        }
      }
    }
    for (const asset of await source.emailAssets([...assetOwners.keys()] as Id<'att'>[])) {
      const owner = assetOwners.get(asset.id);
      if (owner === undefined || ids.files.has(asset.id)) continue;
      ids.files.set(asset.id, {
        source: asset,
        meta: (file) => ({
          id: asset.id,
          kind: 'email_asset',
          filename: asset.filename,
          mime: asset.mime,
          size: file.size,
          sha256: file.sha256,
          automation_id: owner,
          width: asset.width,
          height: asset.height,
        }),
      });
    }

    const emails = new PackageUserEmails(await source.memberEmails());
    const users = { resolve: (value: string) => emails.emailOf(value) };
    const catalog = new PackageSchemaCatalog({ tables: schema.tables });
    const names = new Map<string, string>();
    const rewriter = new PackageRewriter({
      direction: 'export',
      ids,
      users,
      catalog,
      detachedName: (_kind, id) => names.get(id) ?? '',
    });
    await progress.at('schema', 1, 1);

    // --- records ----------------------------------------------------------------------
    let records = 0;
    // Cell files by id: a file belongs to one cell (copies of a file are other attachments).
    const cellOwners = new Map<string, ExportCellFile>();
    const tableCount = schema.tables.length;
    for (const [tableIndex, table] of schema.tables.entries()) {
      signal?.throwIfAborted();
      const attachmentFields = table.fields
        .filter((field) => field.type === 'attachment')
        .map((field) => field.id);
      // Side `a` of each link pair: its cells are the rows of the junction.
      const ownLinks = table.fields.filter(
        (field) => field.type === 'link' && field.link_side === 'a',
      );
      for (const link of ownLinks) {
        spools.set(link.id, new LineSpool(join(options.tempDir, `links-${link.id}.ndjson`)));
      }
      const stream = await source.openRecords(table.id);
      const total = Math.max(stream.rowCount, 1);
      let done = 0;
      const lines = async function* (): AsyncGenerator {
        for await (const batch of stream.records()) {
          signal?.throwIfAborted();
          const wanted = new Set<Id<'att'>>();
          for (const record of batch) {
            for (const fieldId of attachmentFields) {
              for (const id of attachmentIdsOf(record.fields[fieldId])) wanted.add(id);
            }
          }
          if (wanted.size > 0) {
            for (const file of await source.cellFiles(table.id, [...wanted])) {
              cellOwners.set(file.id, file);
              ids.files.set(file.id, {
                source: file,
                meta: (out) => ({
                  id: file.id,
                  kind: 'cell',
                  filename: file.filename,
                  mime: file.mime,
                  size: out.size,
                  sha256: out.sha256,
                  table_id: file.tableId,
                  field_id: file.fieldId,
                  record_id: file.recordId,
                }),
              });
            }
          }
          for (const record of batch) {
            const fields: Record<string, unknown> = { ...record.fields };
            for (const fieldId of attachmentFields) {
              const value = fields[fieldId];
              if (!Array.isArray(value)) continue;
              const own = value.filter((item: unknown) => {
                if (!isRecordObject(item) || !isId('att', item['id'])) return false;
                const owner = cellOwners.get(item['id']);
                return owner?.recordId === record.id && owner.fieldId === fieldId;
              });
              fields[fieldId] = own.length === 0 ? null : own;
            }
            const location = PackageLocation.of(dataEntry(table.id), records + 1);
            ids.records.add(record.id);
            records += 1;
            for (const link of ownLinks) {
              const targets = record.fields[link.id];
              if (!Array.isArray(targets)) continue;
              const spool = spools.get(link.id);
              for (const [position, b] of targets.entries()) {
                if (typeof b === 'string') await spool?.write({ a: record.id, b, position });
              }
            }
            yield {
              id: record.id,
              created_at: record.created_at,
              updated_at: record.updated_at,
              created_by_email: rewriter.userOrNull(record.created_by, location.at('created_by')),
              updated_by_email: rewriter.userOrNull(record.updated_by, location.at('updated_by')),
              auto: record.auto,
              ...(record.parent_id === undefined ? {} : { parent_id: record.parent_id }),
              fields: rewriter.recordFields(fields, table.id, location.at('fields')),
            };
            done += 1;
          }
          await progress.at('records', tableIndex + done / total, tableCount);
        }
      };
      written(await writer.addNdjson(dataEntry(table.id), lines()));
      for (const link of ownLinks) await spools.get(link.id)?.close();
      await progress.at('records', tableIndex + 1, tableCount);
    }

    // --- links ------------------------------------------------------------------------
    let links = 0;
    const spooled = [...spools.entries()];
    for (const [index, [fieldId, spool]] of spooled.entries()) {
      signal?.throwIfAborted();
      const rows = async function* (): AsyncGenerator {
        for await (const row of readSpool(spool.path)) {
          if (!isRecordObject(row)) continue;
          const { a, b, position } = row;
          if (typeof a !== 'string' || typeof b !== 'string' || typeof position !== 'number') {
            continue;
          }
          // Both records must be in the package (one may have left the base meanwhile).
          if (!ids.records.has(a) || !ids.records.has(b)) continue;
          links += 1;
          yield { a, b, position };
        }
      };
      written(await writer.addNdjson(linksEntry(fieldId as Id<'fld'>), rows()));
      await progress.at('links', index + 1, spooled.length);
    }
    await progress.at('links', 1, 1);

    // --- files ------------------------------------------------------------------------
    const files: PackageFileOut[] = [];
    const pending = [...ids.files.values()];
    for (const [index, file] of pending.entries()) {
      signal?.throwIfAborted();
      const name = fileEntry(file.source.id);
      const content = await source.openFile(file.source.object);
      let entry;
      if (isAlreadyCompressed(file.source.mime)) {
        entry = await writer.addFile(name, content, { compress: false });
      } else {
        // Deflated unless that would pass the 20× a reader allows a file
        // (a log, a CSV of repeated rows): then stored. The file is spooled
        // once to measure it, so storage is read once.
        const spool = join(options.tempDir, `file-${file.source.id}`);
        try {
          const measured = await spoolMeasured(content, spool);
          entry = await writer.addFile(name, createReadStream(spool), {
            compress: deflateStaysWithinRatio(
              options.limits,
              classifyEntry(name),
              measured.deflated,
              measured.size,
            ),
            size: measured.size,
          });
        } finally {
          await rm(spool, { force: true });
        }
      }
      written(entry);
      files.push(file.meta({ size: entry.size, sha256: entry.sha256 }));
      await progress.at('files', index + 1, pending.length);
    }

    // --- schema entries ---------------------------------------------------------------
    const detached = new PackageRewriter({
      direction: 'export',
      ids,
      users,
      catalog,
      detachedName: () => '',
    });
    const refs: ExportDetachedRef[] = [];
    for (const automation of schema.automations) {
      // The walk over a copy says which slots it empties; the names come next.
      const probe = detached.automation(structuredClone(automation), PackageLocation.of('probe'));
      for (const slot of probe.detached) {
        const value = pathValue(automation.definition, slot.path);
        if (typeof value === 'string') refs.push({ kind: slot.kind, id: value });
      }
    }
    for (const [id, name] of await source.detachedNames(refs)) names.set(id, name);

    const tablesOut = schema.tables.map((table, index) =>
      rewriter.table(table, PackageLocation.of(SCHEMA_ENTRIES.tables).at('tables', index)),
    );
    const viewsOut = schema.views.map((view, index) =>
      rewriter.view(view, PackageLocation.of(SCHEMA_ENTRIES.views).at('views', index)),
    );
    const dashboardsOut = schema.dashboards.map((dashboard, index) =>
      rewriter.dashboard(
        dashboard,
        PackageLocation.of(SCHEMA_ENTRIES.dashboards).at('dashboards', index),
      ),
    );
    const automationsOut = schema.automations.map((automation, index) => {
      const at = PackageLocation.of(SCHEMA_ENTRIES.automations).at('automations', index);
      const rewritten = rewriter.automation(structuredClone(automation), at);
      return {
        ...rewritten.automation,
        definition: rewriter.emailAssets(rewritten.automation['definition'], at.at('definition')),
      };
    });
    const rolesOut = schema.roles.map((role, index) =>
      rewriter.role(role, PackageLocation.of(SCHEMA_ENTRIES.roles).at('roles', index)),
    );
    written(await writer.addJson(SCHEMA_ENTRIES.tables, { tables: tablesOut }));
    written(await writer.addJson(SCHEMA_ENTRIES.views, { views: viewsOut }));
    written(await writer.addJson(SCHEMA_ENTRIES.dashboards, { dashboards: dashboardsOut }));
    written(await writer.addJson(SCHEMA_ENTRIES.automations, { automations: automationsOut }));
    written(await writer.addJson(SCHEMA_ENTRIES.roles, { roles: rolesOut }));
    written(await writer.addJson(ATTACHMENTS_ENTRY, { files }));
    written(
      await writer.addJson(SCHEMA_ENTRIES.base, {
        name: schema.base.name,
        description: schema.base.description,
        icon: schema.base.icon,
        settings: schema.base.settings,
        missing_ids: rewriter.missingIds(),
      }),
    );

    const counts: BasePackageCounts = {
      tables: schema.tables.length,
      fields: schema.tables.reduce((sum, table) => sum + table.fields.length, 0),
      records,
      links,
      attachments: files.length,
      views: schema.views.length,
      dashboards: schema.dashboards.length,
      widgets: schema.dashboards.reduce((sum, dashboard) => sum + dashboard.widgets.length, 0),
      automations: schema.automations.length,
      roles: schema.roles.length,
    };
    const finished = await writer.finish({
      app_version: options.appVersion,
      exported_at: options.exportedAt.toISOString(),
      exported_by_email: options.exportedByEmail,
      base: { id: schema.base.id, name: schema.base.name },
      counts,
      skipped: { personal_views: schema.personalViews },
    });
    await progress.at('files', 1, 1);
    return {
      bytes: finished.bytes,
      uncompressedBytes: uncompressed,
      counts,
      skippedPersonalViews: schema.personalViews,
    };
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    for (const spool of spools.values()) spool.destroy();
  }
}

/**
 * Copies `source` into a new file at `path` and measures what deflating it
 * gives (zlib level 6, as the writer deflates), without holding it in memory.
 */
async function spoolMeasured(
  source: Readable,
  path: string,
): Promise<{ readonly size: number; readonly deflated: number }> {
  const deflater = createDeflateRaw({ level: 6 });
  let deflated = 0;
  deflater.on('data', (chunk: Buffer) => {
    deflated += chunk.length;
  });
  const deflaterDone = once(deflater, 'end');
  let size = 0;
  const tee = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      size += chunk.length;
      if (deflater.write(chunk)) callback(null, chunk);
      else
        deflater.once('drain', () => {
          callback(null, chunk);
        });
    },
    flush(callback: TransformCallback) {
      deflater.end();
      callback();
    },
  });
  try {
    await pipeline(source, tee, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    await deflaterDone;
  } catch (error) {
    deflater.destroy();
    throw error;
  }
  return { size, deflated };
}

/** The value at a dotted path of a definition (`actions[0].config.secret_id`). */
function pathValue(root: unknown, path: string): unknown {
  let value: unknown = root;
  for (const part of path.split(/\.|(?=\[)/u)) {
    if (part === '') continue;
    const index = /^\[(\d+)\]$/u.exec(part);
    if (index !== null) {
      value = Array.isArray(value) ? value[Number(index[1])] : undefined;
    } else {
      value = isRecordObject(value) ? value[part] : undefined;
    }
  }
  return value;
}

/** Storage key of an exported package: `{org}/base-export-{job}.chbase` (ids only). */
export function basePackageKey(organizationId: Id<'org'>, jobId: Id<'job'>): string {
  return `${organizationId}/base-export-${jobId}.chbase`;
}
