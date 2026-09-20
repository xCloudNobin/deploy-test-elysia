# Elysia Taskboard

A meaningful **Elysia on Bun** application for the xCloud app-compatibility
suite: a project/task board built with the Elysia web framework (`new Elysia()`,
route handlers, lifecycle hooks, and TypeBox `t` validation) running on the Bun
runtime with `bun:sqlite` persistence.

It is a production-process fixture, not a success-page shell: every workflow
reads and writes through parameterized SQLite queries, all input is validated
server-side with meaningful error payloads, and `scripts/verify.sh` exercises
the real production bundle end to end.

## Feature summary

- Elysia routes and lifecycle hooks (`.onError`, `.notFound`) — no Express, no
  raw `Bun.serve` router.
- TypeBox validation via Elysia's `t` schema (`t.Object`, `t.Enum`,
  `t.Optional`, bounds) on request bodies, params and query; validation
  failures return `400` with per-field error objects.
- Projects and tasks with status/priority, search (`q`), and status/priority
  filters — all over a JSON API consumed by a small DOM-rendered client.
- Validated CRUD: blank/over-long/mistyped fields, invalid status/priority,
  malformed JSON, missing references and not-found resources all return
  meaningful JSON errors (400/404); output is escaped client-side by rendering
  via `textContent` only (no `innerHTML` with user data).
- Parameterized SQL everywhere (LIKE wildcards escaped) — no string-built
  queries from user input.
- Idempotent schema setup (`CREATE TABLE IF NOT EXISTS`) and repeatable seed
  data, guarded by a one-time seed flag so re-opens never duplicate rows.
- Persistence: explicit SQLite file (`DATA_DIR`/`DATABASE_PATH`); the app
  never stores permanent state in an ephemeral release directory.
- `/api/health/live` (process alive) and `/api/health/ready` (does a real
  database open + write; **503** while the database is unavailable).
- Non-sensitive release marker: `scripts/build.sh` writes `VERSION` (git SHA
  by default) and builds the production bundle; the marker is served by
  `/api/meta` and shown in the UI footer.
- Graceful SIGTERM/SIGINT shutdown (Elysia `app.stop()` + database close),
  logs to stdout/stderr without credentials.

## Runtime and dependencies

- Bun **1.3.12** validated (any supported Bun ≥ 1.1 works).
- One runtime dependency: `elysia` **1.4.30** (pinned). HTTP, SQLite and the
  test runner are Bun built-ins (`bun:sqlite`, `bun:test`).
- Dev-only: `@types/bun`, `typescript` (strict `tsc --noEmit` typecheck).
- Lockfile `bun.lock` pins the complete toolchain; `bun install --frozen-lockfile`
  reproduces it.

Runtime versions (this verification):

| Component | Version |
|-----------|---------|
| Bun       | 1.3.12  |
| Elysia    | 1.4.30  |
| SQLite    | via `bun:sqlite` (bundled) |

## Quick start (development)

```bash
bun install
cp .env.example .env       # review and adjust
bun run dev                # bun --watch src/index.ts
```

Open http://localhost:8080 — the seeder has already created two demo projects
and a few tasks on first boot.

## Production start

```bash
bun install --frozen-lockfile
bash scripts/build.sh      # writes VERSION + bundles dist/server.js
bun run start              # bun dist/server.js
```

- Binds to `BIND_HOST:PORT` (defaults **0.0.0.0:8080**).
- Logs go to stdout/stderr; the process answers SIGTERM/SIGINT with a clean
  shutdown.

## Health and readiness

| Endpoint | Meaning |
|----------|---------|
| `GET /api/health/live`  | Process is alive (always 200 while serving). |
| `GET /api/health/ready` | Opens the SQLite file and performs a write + read; **503** when the database is unavailable, with a `status: "unavailable"` body and the underlying reason. |

`/api/health/ready` is a genuine dependency probe (fresh connection, real
write), not a static marker. `scripts/smoke.sh` proves it: it points a fresh
production process at a database path that cannot be opened, observes readiness
drop to 503 (liveness stays 200), verifies API routes degrade to 503 and the
static UI still serves.

## Environment variables

See `.env.example` for the full commented list.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | no | `8080` | bind port |
| `BIND_HOST` | no | `0.0.0.0` | bind address |
| `DATA_DIR` | no | `<repo>/data` | base data directory |
| `DATABASE_PATH` | no | `<DATA_DIR>/taskboard.db` | **persistent SQLite path** |
| `BUILD_MARKER` | no | git SHA | release marker in `/api/meta` and the UI footer |

No credentials or secrets are committed or required.

## Persistence

Data lives in the SQLite file at `DATABASE_PATH`, which defaults under
`DATA_DIR` (gitignored). For redeploys that reuse or replace the release
directory, mount a persistent volume at `DATA_DIR`/`DATABASE_PATH` so the
file survives. `scripts/smoke.sh` proves persistence: it creates a "PERSIST"
survivor task over HTTP, gracefully stops the production process, restarts it
on the **same database path**, and verifies the record is still served with
stable counts.

## Schema

Created by `src/db.ts` (`CREATE TABLE IF NOT EXISTS`, idempotent):

- `project` — id, name, description, status (`active|archived`), timestamps.
- `task` — id, `project_id` FK (`ON DELETE CASCADE`), title, description,
  status (`todo|in_progress|done`), priority (`low|medium|high`), timestamps.
- `seed_flag` — marks the one-time seed as applied.
- `heartbeat` — backing table for the readiness write probe.

Seeding is repeatable: the second and subsequent `openDb` calls never add rows
(`tests/app.test.ts` asserts seed idempotency).

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health/live` | liveness |
| GET | `/api/health/ready` | readiness (DB probe) |
| GET | `/api/meta` | release marker + framework/runtime versions |
| GET/POST | `/api/projects` | list / create projects |
| GET/PATCH/DELETE | `/api/projects/:id` | read / update / delete a project |
| GET/POST | `/api/tasks` | list (filters `q`, `status`, `priority`, `project_id`) / create tasks |
| GET/PATCH/DELETE | `/api/tasks/:id` | read / update / delete a task |

The UI at `/` consumes the same JSON API.

## Automated verification

```bash
scripts/verify.sh
```

Runs, in order:

1. `scripts/build.sh` — writes `VERSION` marker and bundles `dist/server.js`.
2. Clean install — `rm -rf node_modules && bun install --frozen-lockfile`.
3. Strict typecheck — `tsc --noEmit`.
4. `bun test` — unit/integration suite: CRUD, search/filter, validation
   negatives (blank/over-long/mistyped fields, invalid status/priority,
   malformed JSON, missing project, empty PATCH, 404s, non-numeric ids),
   LIKE-wildcard escaping, schema/seed idempotency, restart-style persistence,
   and readiness that genuinely drops to 503 when the database is removed.
5. `scripts/smoke.sh` — real production process (`bun dist/server.js`):
   liveness/readiness, CRUD over HTTP, search/status filters, release marker,
   negative cases, graceful stop → restart persistence, database-unavailable
   readiness (503).

Exit 0 only when every check passes. Recorded outcomes: see
`VERIFICATION.md` and the PR description.

## Repository layout

```
src/            Elysia app: config, sqlite db/schema/seed, routes/validation
                (app.ts), index.ts entrypoint, public/ (client UI)
tests/          bun:test suite
scripts/        build.sh (marker + bundle), smoke.sh (production check),
                verify.sh (full verification)
package.json    scripts + pinned elysia dependency (Bun built-ins otherwise)
bun.lock        locked toolchain
```

## License

MIT — see [LICENSE](LICENSE). This fixture is part of the MIT-licensed
[xCloud app-compatibility suite](https://github.com/xCloudNobin/app-compatibility).