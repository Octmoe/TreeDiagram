# Changelog

All notable changes to TreeDiagram are documented in this file. The project follows
[Semantic Versioning](https://semver.org/), including prerelease identifiers while V2 is being
validated outside the original development machine.

## [Unreleased]

### Added

- Git source-release workflow, Apache-2.0 licensing, release checks, and continuous integration.

## [2.0.0-alpha.1] - 2026-08-11

### Added

- Project-isolated `treediagram-v2` workspaces backed by SQLite.
- Persistent Working State, reviewable ChangeSets, deterministic validation, and immutable releases.
- Shared attention with session isolation and explicit focus recovery.
- Loopback Sidecar with dark and light themes, candidate projection, relation inspection, and
  approval-gated actions.
- Codex plugin with automatic project binding, stdio MCP, lifecycle hooks, and six guided skills:
  Initialize, Derive, Grill, Check, Unbox, and Re-evaluate.
- Source-based local installation and standalone design-tree launcher.

### Changed

- V2 is a clean-start product boundary and does not migrate or read V1 workspaces.

### Security

- Destructive and high-authority operations require scoped, expiring, single-use approvals.
- Sidecar HTTP traffic is loopback-only and browser writes are same-origin restricted.
