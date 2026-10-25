export interface GitCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly message: string;
}

export interface DcoViolation {
  readonly sha: string;
  readonly subject: string;
  readonly authorEmail: string;
  readonly reason: 'missing-sign-off' | 'email-mismatch';
  /** Emails found in `Signed-off-by:` trailers, if any. */
  readonly signedOffEmails: readonly string[];
}

const SIGN_OFF = /^Signed-off-by:[^\S\n]*[^<\n]*<([^>\n]+)>[^\S\n]*$/gim;

/** Emails of every well-formed `Signed-off-by: Name <email>` line in a commit message. */
export function signedOffEmails(message: string): string[] {
  return [...message.matchAll(SIGN_OFF)].map((match) => (match[1] ?? '').trim());
}

/**
 * Every non-merge commit needs a `Signed-off-by:` trailer whose email matches
 * the author email (case-insensitive). Returns the offending commits.
 */
export function checkDco(commits: readonly GitCommit[]): DcoViolation[] {
  const violations: DcoViolation[] = [];
  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    const emails = signedOffEmails(commit.message);
    const author = commit.authorEmail.trim().toLowerCase();
    if (emails.some((email) => email.toLowerCase() === author)) continue;
    violations.push({
      sha: commit.sha,
      subject: commit.message.split('\n', 1)[0] ?? '',
      authorEmail: commit.authorEmail,
      reason: emails.length === 0 ? 'missing-sign-off' : 'email-mismatch',
      signedOffEmails: emails,
    });
  }
  return violations;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** `git log` format understood by {@link parseGitLog}. */
export const GIT_LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%B'].join('%x1f') + '%x1e';

export function parseGitLog(output: string): GitCommit[] {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha = '', parents = '', authorName = '', authorEmail = '', message = ''] =
        record.split(FIELD);
      return {
        sha,
        parents: parents.split(' ').filter((parent) => parent !== ''),
        authorName,
        authorEmail,
        message: message.trimEnd(),
      };
    });
}

export function formatDcoViolation(violation: DcoViolation): string {
  const commit = `${violation.sha.slice(0, 12)} "${violation.subject}"`;
  if (violation.reason === 'missing-sign-off') {
    return `${commit}: missing "Signed-off-by:" trailer for ${violation.authorEmail}`;
  }
  return (
    `${commit}: sign-off (${violation.signedOffEmails.join(', ')}) ` +
    `does not match author email ${violation.authorEmail}`
  );
}
