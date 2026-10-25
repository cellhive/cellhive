# Security policy

## Supported versions

Cellhive has no release yet. Once releases start, security fixes go to the latest minor release. Every minor release can be upgraded from the previous one.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue, discussion or pull request.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include:

- the affected version or commit,
- steps to reproduce or a proof of concept,
- the impact you observed (for example data from another organization, a field hidden by permissions, or code execution).

## What to expect

| Step                                      | Target time                                             |
| ----------------------------------------- | ------------------------------------------------------- |
| Acknowledge the report                    | 3 business days                                         |
| First assessment and severity             | 10 business days                                        |
| Fix released for critical and high issues | 30 days                                                 |
| Public advisory                           | after a fix is available, coordinated with the reporter |

We credit reporters in the advisory unless they ask not to be named.

## Scope

In scope: the code in this repository and the official Docker images. Especially relevant for this project: tenant isolation, permission checks (table, field, record, share links), SQL generation, formula and filter evaluation, SSRF in outgoing webhooks, file upload and download, authentication and sessions.

Out of scope: vulnerabilities in a third-party dependency with no demonstrated impact on Cellhive, and issues that need an already compromised server or database administrator access.
