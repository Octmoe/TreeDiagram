# Contributing to TreeDiagram

Thank you for improving TreeDiagram. Contributions are accepted under the Apache License 2.0.

## Development setup

TreeDiagram V2 requires Node.js 24 or newer and npm.

```powershell
npm ci
npm run build
npm test
```

For browser tests, install Chromium once and run the suite:

```powershell
npx playwright install chromium
npm run test:e2e
```

## Pull requests

- Keep changes focused and explain the user-visible outcome.
- Add or update tests for contract, domain, storage, MCP, and Sidecar behavior as appropriate.
- Run `npm run release:verify` before requesting review.
- Do not commit `node_modules`, build output, logs, `.treediagram`, SQLite files,
  `plugins/treediagram/.mcp.json`, or `plugins/treediagram/runtime.local.json`.
- Do not weaken approval, lease, workspace-isolation, or same-origin boundaries without an explicit
  design change and security review.
- Treat V1 as archived. New product behavior belongs to the V2 packages and Sidecar.

## Design changes

Changes to durable concepts or contracts should update `DESIGN_V2.md`, `docs/V2_CONTRACTS.md`, and
the affected tests together. Keep Agent proposals reviewable; chat text is not adoption or release
authorization.

## Security reports

Follow `SECURITY.md`; do not disclose unpatched vulnerabilities in public issues or pull requests.
