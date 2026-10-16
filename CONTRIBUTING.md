# Contributing to neatroots

Issues, fixes, documentation improvements, and new checks are welcome. Start with the
[README](README.md) and [architecture](docs/architecture.md) to understand the project.
[AGENTS.md](AGENTS.md) contains the coding and UI conventions for all contributors.

## Reporting an issue

Search the [existing issues](https://github.com/neatlogs/neatroots/issues) before opening one.
Use the [bug report](https://github.com/neatlogs/neatroots/issues/new?template=bug-report.yml)
for a defect, or the [tester report](https://github.com/neatlogs/neatroots/issues/new?template=tester-report.yml)
for feedback from the [tester guide](docs/tester-guide.md).

Include the version or commit, OS, how the agent sends runs, steps to reproduce, and expected
versus actual behavior. A small synthetic trace or mock-backed example is especially useful.
Include relevant logs or `neatroots doctor` output, but remove API keys and customer data.
For a proposed behavior change, explain the use case and any compatibility tradeoffs.

## Project boundaries

- Build from public inputs: the public Neatlogs SDKs and their telemetry schema and doctor
  contract, OpenTelemetry, MCP, publicly documented APIs, and openly licensed models. Do not
  copy code, prompts, schemas, or logic from Neatlogs' internal services. The shared UI
  primitives are the exception; keep them in step with the Neatlogs design system.
- Keep operation local by default. Sending data to a hosted LLM, Jev cloud, or Neatlogs Cloud
  requires the user to turn it on.
- Preserve lossless stored spans and compatibility with the public SDKs, including
  `/v1/traces` and doctor read-back.
- Write the project name as **neatroots** in prose, UI, and documentation.

## Local setup

Use macOS or Linux, or WSL on Windows. The workspace requires Node.js 22 or newer;
[.nvmrc](.nvmrc) selects the development major version. Use the pnpm version declared in
[package.json](package.json). The commands below use a POSIX shell and start at the repository
root unless stated otherwise.

```bash
pnpm install --frozen-lockfile
pnpm build
```

The build compiles the UI, server, and TypeScript steering hook, and copies the UI into the
server bundle. For development, run these in separate terminals:

```bash
NEATROOTS_DEV_ORIGIN=http://localhost:5173 pnpm --filter @neatlogs/neatroots dev
```

```bash
pnpm --filter @neatlogs/neatroots-ui dev
```

The server listens on port 4100 and the UI development server on 5173. For Python steering
work, create a virtual environment and install its test extra:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e "python/neatroots-steer[test]"
```

The hook's supported Python range is declared in
[pyproject.toml](python/neatroots-steer/pyproject.toml); CI currently tests it on Python 3.12.

## Validating a change

For code changes, run the workspace checks:

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

The root `pnpm test` runs both the server and TypeScript steering suites. Run the Python
suite from the root with the virtual environment activated:

```bash
python -m pytest python/neatroots-steer -q
```

Add regression coverage for behavioral fixes, using an isolated home or temporary directory
when a test writes configuration or stored runs. Tests should use synthetic data and mocks;
real provider calls must be explicitly opted into. Keep broad formatting changes separate
from behavioral changes and review the generated diff.

### UI changes

Build before running Playwright; the e2e command does not build the application:

```bash
pnpm --filter @neatlogs/neatroots-ui exec playwright install --with-deps chromium
pnpm --filter @neatlogs/neatroots-ui e2e
pnpm --filter @neatlogs/neatroots-ui e2e --repeat-each=3
```

Playwright starts a real server with an isolated home, mock LLM, and seeded runs. New UI flows
need a spec in `packages/ui/e2e/`; tests must not depend on state another test changes.
Check light and dark themes and a 390px width with screenshots. Follow the shared component,
semantic token, fixed-height row, and scrolling conventions in [AGENTS.md](AGENTS.md).

### Examples and integration paths

For changes affecting ingestion, SDK compatibility, steering, or replay, run the relevant
examples. The example runner needs `uv`, Node.js, `python3`, and `curl`. After building, start
the server from this checkout in one terminal:

```bash
NEATROOTS_HOME="$PWD/.neatroots-dev" node packages/neatroots/dist/cli.js start
```

In another terminal at the repository root:

```bash
NEATROOTS_BIN="node $PWD/packages/neatroots/dist/cli.js" sh examples/run-all.sh
```

The runner automates 11 of the 15 example directories. `browser`, `import-files`, `refund-agent`,
and `samples` are manual scenarios; see [examples/README.md](examples/README.md) for their
instructions.

Use a checkout path without spaces for this command: the runner splits `NEATROOTS_BIN` into
command arguments. The runner starts the mock LLM if needed. Examples need no provider API
keys by default; individual examples support `REAL_LLM=1` for explicitly requested live runs.
See [examples/README.md](examples/README.md) for individual scenarios.

## CI and dependency changes

[ci.yml](.github/workflows/ci.yml) is the source of truth for CI commands and runtime versions.
It runs on pull requests and pushes to `main`:

- Linux and macOS: build, typecheck, server and TypeScript steering tests, Python steering
  tests, and installer checks against a freshly packaged bundle.
- Linux: Playwright tests and the example runner in separate jobs.

When changing JavaScript dependencies, update the relevant manifest and `pnpm-lock.yaml`
together, then verify `pnpm install --frozen-lockfile`. For Python dependency changes, verify
the test-extra installation in a fresh virtual environment. Keep runtime support declarations,
CI configuration, and documentation consistent when changing supported versions.

For installer or packaging changes, reproduce the bundle checks in the CI workflow using
temporary install and bin directories. When diagnosing a failure, record the exact command,
runtime and dependency versions, and first meaningful error. Compare unexpected failures
with the base branch before attributing them to the change.

## Preparing a pull request

Keep each PR focused on a reviewable change. In its description:

- Explain the problem and resulting behavior, and link any related issue.
- List the exact validation commands and results, including checks not run and why.
- Include screenshots for UI changes.
- Describe compatibility, stored-data, privacy, security, or release impact where relevant.
- Update affected documentation and examples.

For documentation-only changes, check links, command accuracy, and `git diff --check`;
application tests are unnecessary unless the change also affects executable behavior.
Before requesting review, inspect the final diff and the CI results.
