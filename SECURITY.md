# Security Policy

## Supported versions

TreeDiagram V2 is currently a prerelease. Security fixes are applied to the latest published V2
prerelease only.

| Version          | Supported |
| ---------------- | --------- |
| `2.0.0-alpha.x`  | Yes       |
| Earlier versions | No        |

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use the repository's private security
advisory flow and include:

- the affected version and operating system;
- a minimal reproduction or proof of concept;
- the security impact and required user interaction;
- whether project data, approval grants, hooks, or process boundaries are involved.

If private advisories are not enabled yet, contact the repository owner privately before sharing
technical details. Maintainers should acknowledge a report before discussing public disclosure.

## Security and privacy boundaries

- Project design state is stored under `<project>/.treediagram/`. It is not uploaded by
  TreeDiagram and is excluded from this repository by default.
- The Sidecar binds to `127.0.0.1`, runs as a per-project background process, and persists until
  explicitly stopped, terminated, or the computer shuts down.
- TreeDiagram does not call a model and does not store model-private reasoning.
- Installing dependencies contacts the configured npm registry. TreeDiagram may run `npm ci` and
  build the local runtime when required.
- The Codex `SessionStart` hook must be reviewed and trusted by the user. It binds the current task
  directory to its own workspace and may start or reuse that project's Sidecar.
- Approval grants are scoped, expiring, version-bound, single-use tokens; only hashes are persisted.
- Back up or inspect `.treediagram` only after stopping that project's Sidecar so SQLite files are
  copied consistently.

## Dependency handling

Release checks use the committed lockfile and `npm ci`. Production dependency advisories at high or
critical severity block release preparation.
