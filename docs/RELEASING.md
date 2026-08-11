# Releasing TreeDiagram from Git

TreeDiagram is distributed as source code through a Git repository and tagged GitHub releases. It
is not published to npm or the public Codex plugin directory.

## Release contract

- The Git tag is the source of truth for a released version.
- GitHub's generated source ZIP and tarball are the release artifacts.
- Generated machine bindings and project data are never release artifacts.
- The first public V2 line uses prerelease tags until installation has been validated on clean
  machines outside the original development environment.

## Versioning

Use Semantic Versioning:

- `v2.0.0-alpha.N`: external preview; behavior and installation may still change.
- `v2.0.0-beta.N`: intended product boundary is complete; compatibility testing remains.
- `v2.0.0-rc.N`: release candidate; contracts and data format are frozen except for blocking fixes.
- `v2.0.0`: stable V2.

Set every workspace and plugin manifest to the same base version:

```powershell
npm run version:set -- 2.0.0-alpha.1
```

Codex development cachebusters may temporarily append `+codex.<token>` to the plugin version, but
tagged source must contain the clean release version.

## Preflight

1. Confirm the `origin` remote points to the intended release repository.
2. Confirm `git status --short` is empty and the branch contains only intended V2 release content.
3. Run the metadata and source-boundary check:

   ```powershell
   npm run release:check
   ```

4. Run the complete deterministic gate:

   ```powershell
   npm run release:verify
   ```

5. Clone the exact commit into a new directory, then verify the documented source install:

   ```powershell
   npm ci
   npm run install:codex
   ```

6. Confirm a new Codex task exposes the TreeDiagram skills and MCP tools, and confirm the standalone
   launcher can reopen an existing design without initializing a new workspace.

## Tag and publish

Create an annotated or signed tag only after all checks pass:

```powershell
git tag -s v2.0.0-alpha.1 -m "TreeDiagram v2.0.0-alpha.1"
git push origin v2.0.0-alpha.1
```

Create a draft GitHub Release from that tag, copy the corresponding changelog section, state the
supported operating systems and known limitations, mark prereleases as prereleases, then publish.
Do not upload `node_modules`, `dist`, `.treediagram`, SQLite databases, `.mcp.json`, or
`runtime.local.json`.

## Upgrade and rollback

- Upgrade by checking out the newer tag and running `npm run update:codex`.
- Start a new Codex task after installation so updated skills and tools are loaded.
- Roll back by checking out the previous tag and reinstalling it.
- V2 project data stays under each project's `.treediagram` directory. Plugin removal must preserve
  it unless the user explicitly deletes that data.
- V1 workspaces are not migrated or read by V2; the archive tag remains the recovery boundary.
