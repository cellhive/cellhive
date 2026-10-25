import { sql, type Kysely } from 'kysely';

/**
 * Migration 0029 (BACKLOG T530, ADR-33): sender identities.
 *
 * - `meta.email_identities`: an address the organization verified and
 *   automation emails may be sent as. Transport `system` (instance SMTP) has
 *   no SMTP columns; transport `smtp` has all of them, the password sealed
 *   with AES-256-GCM under a key derived from `APP_MASTER_KEY`
 *   (`smtp_password_enc`, never returned). `smtp_version` grows whenever the
 *   endpoint or the credentials change (cached transports are rebuilt).
 *   `auth_failures` counts consecutive authentication failures while
 *   sending (3 → `status = error`). `status_before_disable` is where
 *   `enable` returns to.
 * - `meta.email_identity_bases`: the bases of a `selected` scope.
 * - `meta.email_identity_verifications`: the one live verification of an
 *   identity (a new send replaces it): SHA-256 of the link secret, HMAC of
 *   the 6-digit code, the address it was sent to, wrong-code count, 24 h.
 *
 * Every foreign key between tenant tables is composite with
 * `organization_id` (SPEC §5.10, T501). Static DDL on `meta.*` only.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.email_identities (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     email text NOT NULL,
     display_name text NOT NULL,
     reply_to text,
     transport text NOT NULL,
     mode text NOT NULL,
     status text NOT NULL DEFAULT 'pending',
     status_before_disable text,
     error_reason text,
     verified_at timestamptz,
     verified_via text,
     base_scope text NOT NULL DEFAULT 'all',
     signature_md text,
     smtp_host text,
     smtp_port integer,
     smtp_security text,
     smtp_username text,
     smtp_password_enc text,
     smtp_version integer NOT NULL DEFAULT 1,
     auth_failures integer NOT NULL DEFAULT 0,
     created_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT email_identities_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT email_identities_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT email_identities_organization_id_email_key UNIQUE (organization_id, email),
     CONSTRAINT email_identities_email_check
       CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
     CONSTRAINT email_identities_display_name_check
       CHECK (char_length(display_name) BETWEEN 1 AND 100),
     CONSTRAINT email_identities_reply_to_check
       CHECK (reply_to IS NULL OR char_length(reply_to) BETWEEN 3 AND 254),
     CONSTRAINT email_identities_transport_check CHECK (transport IN ('system', 'smtp')),
     CONSTRAINT email_identities_mode_check CHECK (mode IN ('send_as', 'on_behalf')),
     CONSTRAINT email_identities_smtp_mode_check CHECK (transport = 'system' OR mode = 'send_as'),
     CONSTRAINT email_identities_status_check
       CHECK (status IN ('pending', 'verified', 'error', 'disabled')),
     CONSTRAINT email_identities_status_before_disable_check
       CHECK ((status = 'disabled') = (status_before_disable IS NOT NULL)
              AND (status_before_disable IS NULL
                   OR status_before_disable IN ('pending', 'verified', 'error'))),
     CONSTRAINT email_identities_error_check
       CHECK (error_reason IS NULL OR error_reason IN ('auth_failed')),
     CONSTRAINT email_identities_verified_check
       CHECK ((verified_at IS NULL) = (verified_via IS NULL)
              AND (verified_via IS NULL OR verified_via IN ('link', 'code'))),
     CONSTRAINT email_identities_base_scope_check CHECK (base_scope IN ('all', 'selected')),
     CONSTRAINT email_identities_signature_check
       CHECK (signature_md IS NULL OR char_length(signature_md) <= 2000),
     CONSTRAINT email_identities_smtp_check CHECK (
       CASE transport
         WHEN 'smtp' THEN smtp_host IS NOT NULL AND smtp_port IN (25, 465, 587, 2525)
           AND smtp_security IN ('tls', 'starttls', 'none') AND smtp_username IS NOT NULL
           AND smtp_password_enc IS NOT NULL
         ELSE smtp_host IS NULL AND smtp_port IS NULL AND smtp_security IS NULL
           AND smtp_username IS NULL AND smtp_password_enc IS NULL
       END),
     CONSTRAINT email_identities_counters_check CHECK (smtp_version >= 1 AND auth_failures >= 0)
   )`,
  `CREATE TRIGGER email_identities_set_updated_at BEFORE UPDATE ON meta.email_identities
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.email_identity_bases (
     organization_id text NOT NULL,
     identity_id text NOT NULL,
     base_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (identity_id, base_id),
     CONSTRAINT email_identity_bases_identity_fkey FOREIGN KEY (organization_id, identity_id)
       REFERENCES meta.email_identities (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT email_identity_bases_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE
   )`,
  // The base cascade and "identities usable in this base".
  `CREATE INDEX email_identity_bases_base_idx
     ON meta.email_identity_bases (organization_id, base_id)`,

  `CREATE TABLE meta.email_identity_verifications (
     identity_id text PRIMARY KEY,
     organization_id text NOT NULL,
     email text NOT NULL,
     token_hash text NOT NULL,
     code_hash text NOT NULL,
     failed_attempts integer NOT NULL DEFAULT 0,
     requested_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT email_identity_verifications_identity_fkey
       FOREIGN KEY (organization_id, identity_id)
       REFERENCES meta.email_identities (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT email_identity_verifications_token_hash_key UNIQUE (organization_id, token_hash),
     CONSTRAINT email_identity_verifications_hash_check
       CHECK (token_hash ~ '^[0-9a-f]{64}$' AND code_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT email_identity_verifications_attempts_check CHECK (failed_attempts >= 0)
   )`,
  `CREATE TRIGGER email_identity_verifications_set_updated_at
     BEFORE UPDATE ON meta.email_identity_verifications
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
