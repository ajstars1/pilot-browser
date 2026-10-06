# Contributing

Thanks for helping. A few things make reviews fast.

## Setup

```bash
npm install && npm run build
npm run typecheck && npm test
PILOT_E2E=1 npm test   # needs Chrome/Chromium; set PILOT_CHROME if it isn't at a standard path
```

## Ground rules

- **TypeScript strict.** No `any`, named exports only, `.js` import suffixes (NodeNext). Validate every MCP tool input with zod.
- **Real browsers in e2e tests, no mocks.** Unit tests may use a scripted driver for server logic only.
- **Security-relevant changes come with an attack.** If you touch policy, approvals, the overlay or the lease, add or extend a scenario in `packages/mcp/src/__tests__/injection.e2e.test.ts` with a fixture in `test-fixtures/injection/`. Explain what it proves.
- **Never run tests against a real browser profile.** Use throwaway `--user-data-dir`s, as the existing tests do.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).

## Reporting vulnerabilities

Please don't open a public issue. Use **Security → Report a vulnerability** on GitHub (private advisory). See [docs/SECURITY.md](docs/SECURITY.md) for the threat model.
