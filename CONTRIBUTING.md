# Contributing to iPodRocks

## Development Workflow

From v1.0.0.1 onward:

- **main** — Stable releases
- **dev** — Development branch; all new work goes here

## Pull Requests

1. Create a branch from **dev**
2. Make your changes
3. Ensure tests pass: `cd ipodrocks-js && npm run test -- --run`
4. Ensure build succeeds: `cd ipodrocks-js && npm run build`
5. Open a PR into **dev**

PRs to **main** must:

- Originate from **dev**
- Pass CI (GitHub Actions: tests + build)
- Be reviewed and approved

## Running Tests

```bash
cd ipodrocks-js
npm install
npm run test -- --run
```

## Code Style

- TypeScript throughout
- Follow existing patterns in the codebase
- Add tests for new functionality
