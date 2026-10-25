import { describe, expect, it } from 'vitest';

import { checkDco, GIT_LOG_FORMAT, parseGitLog, type GitCommit } from '../src/dco.ts';

function commit(overrides: Partial<GitCommit> & Pick<GitCommit, 'message'>): GitCommit {
  return {
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    authorName: 'Jane Doe',
    authorEmail: 'jane@example.com',
    ...overrides,
  };
}

describe('checkDco', () => {
  const cases: {
    title: string;
    commit: GitCommit;
    expected: 'missing-sign-off' | 'email-mismatch' | null;
  }[] = [
    {
      title: 'signed-off commit passes',
      commit: commit({ message: 'feat: x\n\nSigned-off-by: Jane Doe <jane@example.com>' }),
      expected: null,
    },
    {
      title: 'email comparison is case-insensitive',
      commit: commit({ message: 'feat: x\n\nSigned-off-by: Jane Doe <Jane@Example.COM>' }),
      expected: null,
    },
    {
      title: 'one matching trailer among several passes',
      commit: commit({
        message:
          'feat: x\n\nSigned-off-by: Bob <bob@example.com>\nSigned-off-by: Jane <jane@example.com>',
      }),
      expected: null,
    },
    {
      title: 'unsigned commit fails',
      commit: commit({ message: 'feat: x\n\nbody text' }),
      expected: 'missing-sign-off',
    },
    {
      title: 'sign-off without an email fails',
      commit: commit({ message: 'feat: x\n\nSigned-off-by: Jane Doe' }),
      expected: 'missing-sign-off',
    },
    {
      title: 'sign-off mentioned mid-line does not count',
      commit: commit({ message: 'feat: x\n\nsee Signed-off-by: Jane <jane@example.com>' }),
      expected: 'missing-sign-off',
    },
    {
      title: 'mismatched email fails',
      commit: commit({ message: 'feat: x\n\nSigned-off-by: Jane Doe <jane@other.org>' }),
      expected: 'email-mismatch',
    },
    {
      title: 'merge commit is ignored',
      commit: commit({ parents: ['b'.repeat(40), 'c'.repeat(40)], message: 'Merge branch x' }),
      expected: null,
    },
  ];

  it.each(cases)('$title', ({ commit: input, expected }) => {
    expect(checkDco([input]).map((violation) => violation.reason)).toEqual(
      expected ? [expected] : [],
    );
  });

  it('returns only offending commits with their subject', () => {
    const good = commit({
      sha: '1'.repeat(40),
      message: 'a\n\nSigned-off-by: J <jane@example.com>',
    });
    const bad = commit({ sha: '2'.repeat(40), message: 'fix: y\n\nno trailer' });
    expect(checkDco([good, bad])).toEqual([
      {
        sha: '2'.repeat(40),
        subject: 'fix: y',
        authorEmail: 'jane@example.com',
        reason: 'missing-sign-off',
        signedOffEmails: [],
      },
    ]);
  });
});

describe('parseGitLog', () => {
  it('uses unit/record separators in the format', () => {
    expect(GIT_LOG_FORMAT).toBe('%H%x1f%P%x1f%an%x1f%ae%x1f%B%x1e');
  });

  it('parses records produced by GIT_LOG_FORMAT', () => {
    const output =
      ['1'.repeat(40), '2'.repeat(40), 'Jane Doe', 'jane@example.com', 'feat: x\n\nbody\n'].join(
        '\x1f',
      ) +
      '\x1e\n' +
      [
        '3'.repeat(40),
        `${'4'.repeat(40)} ${'5'.repeat(40)}`,
        'Bob',
        'bob@example.com',
        'Merge\n',
      ].join('\x1f') +
      '\x1e\n';
    expect(parseGitLog(output)).toEqual([
      {
        sha: '1'.repeat(40),
        parents: ['2'.repeat(40)],
        authorName: 'Jane Doe',
        authorEmail: 'jane@example.com',
        message: 'feat: x\n\nbody',
      },
      {
        sha: '3'.repeat(40),
        parents: ['4'.repeat(40), '5'.repeat(40)],
        authorName: 'Bob',
        authorEmail: 'bob@example.com',
        message: 'Merge',
      },
    ]);
  });

  it('returns no commits for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});
