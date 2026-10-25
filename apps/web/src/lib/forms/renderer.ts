import type {
  CreateUploadResponse,
  FieldDto,
  FormSubmitRequest,
  FormSubmitResponse,
  FormSubmitTokenDto,
  StoredFormSettings,
} from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';
import type { ComponentType, ReactNode } from 'react';

/**
 * The contract of `FormRenderer` (T315), the form a person fills in: on the
 * form view of a base (`features/form`) and on the public share page
 * (`/s/:token`, T317). Features do not import each other (FRONTEND §1.2):
 * the route hands the component to the share page, typed by this file.
 */

/**
 * A field a question asks for: a table field (CONTRACTS §13) or a field of a
 * share link (`SharedField`, which has no `required`: the form's own
 * `required` already includes the table's, CONTRACTS §15).
 */
export interface FormRendererField {
  readonly id: string;
  readonly name: string;
  readonly type: FieldDto['type'];
  readonly options: FieldDto['options'];
  readonly description: string | null;
  /** The primary field (a title: one line of text). */
  readonly is_primary?: boolean | undefined;
  /** Required by the table: always required on the form. */
  readonly required?: boolean | undefined;
}

/**
 * A person a `user` question may pick (people who can open the base). The
 * email is `null` on a form link (`GET /shares/:token/members` never gives
 * one, CONTRACTS §17).
 */
export interface FormMember {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

/**
 * Anti-spam of forms reached through a link (CONTRACTS §17, ADR-0030): a
 * signed submit token fetched when the form opens (usable after a minimum
 * fill time) and a honeypot input people never see. Member forms do not
 * use it.
 */
export interface FormAntiSpam {
  /** `GET /shares/:token/submit-token`. */
  readonly fetchToken: (signal?: AbortSignal) => Promise<FormSubmitTokenDto>;
}

/** A record a link question offers (T410): id, title and, for members, its display values. */
export interface FormLinkOption {
  readonly id: string;
  /** Primary field as text; `null` when it cannot be read. */
  readonly title: string | null;
  /**
   * Display values as text (T421a, like the link picker: ≤ 3 fields), told
   * apart records with the same title. Members only: form links send the
   * title alone (CONTRACTS §17).
   */
  readonly details?: readonly string[] | undefined;
}

export interface FormLinkPage {
  readonly items: readonly FormLinkOption[];
  readonly hasMore: boolean;
}

/**
 * The records link questions offer (T410): members through `POST
 * /fields/:id/link-candidates` (T402), `org` form links through `GET
 * /shares/:token/link-candidates/:fieldId`. Public form links have no link
 * questions (CONTRACTS §17).
 */
export interface FormLinkSource {
  readonly search: (
    fieldId: string,
    query: { readonly search: string; readonly offset: number },
    signal?: AbortSignal,
  ) => Promise<FormLinkPage>;
}

/** A finished upload of a file question: sent as `[{ id }]`. */
export interface FormUploadedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
}

/**
 * Uploads of file questions (T410): members through `POST /files/uploads`
 * (T406), form links through `POST /shares/:token/uploads`, bound to the
 * submit token the form will be sent with (`submitToken`, `null` for
 * members).
 */
export interface FormUploadSource {
  readonly start: (
    body: {
      readonly field_id: string;
      readonly filename: string;
      readonly size: number;
      readonly mime: string;
    },
    submitToken: string | null,
    signal?: AbortSignal,
  ) => Promise<CreateUploadResponse>;
  readonly complete: (
    attachmentId: string,
    submitToken: string | null,
    signal?: AbortSignal,
  ) => Promise<FormUploadedFile>;
  /** Most files per question on top of the field's `max_files` (form links: 10). */
  readonly maxFilesPerQuestion?: number | undefined;
  /** Most bytes of every file of one submission (form links: 100 MB, CONTRACTS §17). */
  readonly maxTotalBytes?: number | undefined;
}

/** Time source of the renderer (tests replace it). */
export interface FormClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface FormRendererProps {
  /** The form settings of the view (`config.form`). */
  readonly form: StoredFormSettings;
  /** Fields the questions may name; questions on other fields are left out. */
  readonly fields: readonly FormRendererField[];
  /** Locale and time zone numbers and dates are typed in. */
  readonly locale: LocaleContext;
  /**
   * The query string of the page: `?prefill_<field_id>=…&hide_<field_id>=1`
   * (BACKLOG S3 decision 9). Omitted = no prefill.
   */
  readonly search?: string | undefined;
  /** Sends a submission; omitted = preview (nothing is sent). */
  readonly submit?: ((body: FormSubmitRequest) => Promise<FormSubmitResponse>) | undefined;
  /** Submit token + honeypot (link forms, T317). */
  readonly antiSpam?: FormAntiSpam | undefined;
  /** People a `user` question offers; omitted = user questions cannot be answered here. */
  readonly members?: readonly FormMember[] | undefined;
  /** Records link questions offer (T410); omitted = link questions cannot be answered here. */
  readonly links?: FormLinkSource | undefined;
  /** Uploads of file questions (T410); omitted = files cannot be added here (preview). */
  readonly uploads?: FormUploadSource | undefined;
  /**
   * The person already reached the form's submission limit
   * (`GET /views/:id/submission-status`, T320): the form opens on the
   * limit screen instead of letting them fill it in for nothing.
   */
  readonly limitReached?: { readonly nextAllowedAt: string | null } | null | undefined;
  /** Why this person cannot submit (shown instead of the send button), e.g. no right to add records. */
  readonly blocked?: ReactNode;
  /** Opens the form's `redirect_url` after a submission (default: the browser navigates). */
  readonly onRedirect?: ((url: string) => void) | undefined;
  readonly clock?: FormClock | undefined;
  /** Level of the form title: `1` on a page of its own (the share page), `2` inside the app. */
  readonly headingLevel?: 1 | 2 | undefined;
  /**
   * Where the cover image of the form is read (`config.form.cover_attachment_id`,
   * T419): through the view for members, through the link on the share page.
   * Omitted = no cover shown.
   */
  readonly coverUrlOf?: ((attachmentId: string) => string) | undefined;
}

export type FormRendererComponent = ComponentType<FormRendererProps>;
