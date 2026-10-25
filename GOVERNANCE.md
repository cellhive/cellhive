# Governance

## Commitments

These commitments do not change with who maintains the project:

- Every feature is open source under AGPL-3.0. There is no enterprise edition, license check or feature gate.
- Contributions use the DCO, not a CLA. Copyright stays with each contributor, so the project cannot be relicensed without them.
- No telemetry by default and no mandatory external service.

## Roles

- **Contributors**: anyone who opens an issue, reviews or submits a pull request.
- **Maintainers**: can merge pull requests, triage issues and cut releases. Current maintainers are listed below.

| Maintainer                          | Areas |
| ----------------------------------- | ----- |
| [MAINTAINER_NAME] ([GITHUB_HANDLE]) | All   |

**Code of Conduct and general contact:** [CONDUCT_CONTACT_EMAIL]. Security reports follow [SECURITY.md](SECURITY.md).

## How decisions are made

- Day-to-day changes: a pull request is merged after approval from at least one maintainer who is not the author, with CI green. While there is only one maintainer, that maintainer may merge their own changes after CI passes and at least 24 hours of public visibility.
- Architecture changes: an ADR in `docs/adr/`, open for comment for at least 7 days before it is accepted.
- Breaking changes to `/api/v1`: not allowed within a major version.
- Disagreements are discussed on the pull request or issue. If maintainers cannot agree, the decision is made by majority of maintainers; ties keep the current behavior.

## Becoming a maintainer

A contributor with a track record of good reviews and merged work can be nominated by any maintainer. The nomination is accepted when no maintainer objects within 7 days.

## Roadmap

The roadmap follows the sprint plan in [`docs/SPEC.md`](docs/SPEC.md) §22; planned work is tracked in GitHub issues.
