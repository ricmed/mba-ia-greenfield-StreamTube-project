# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio mc ready local` — expect no error
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

The `video-worker` is **not** an application server in the sense above: it is
the consumer half of the pipeline, declared in `compose.yaml`, and comes up
with the rest of the infrastructure. Uploads complete without it, but nothing
ever leaves `processing_status = processing`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, API `9000`, console `9001`
- `redis` — Redis 8, port `6379`, backs the BullMQ queue
- `video-worker` — same image and codebase as the API, running `npm run start:worker:dev`
  (entrypoint `src/worker.ts`): no HTTP layer, only the queue consumer

The worker's first boot compiles the project over the bind mount and can take
several minutes; `docker compose logs -f video-worker` shows when it is ready.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify storage and queue
docker compose exec minio mc ready local
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker:dev                 # Video worker, watch mode (what video-worker runs)
npm run start:worker                     # Video worker from dist/

npm run openapi:export                   # Regenerate the versioned openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
docker compose exec minio mc ready local
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # serial via maxWorkers in test/jest-e2e.json
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Tests also need real storage, queue and **ffmpeg**, all of which the container
already provides (`Dockerfile.dev` installs ffmpeg, which `FfmpegService` and
the fixture generator in `src/test/video-fixture.ts` call through `execFile`).

**A test DataSource must list every entity of the project**, not just the ones
it touches: TypeORM resolves both sides of each relation while building the
metadata, so a suite listing only `Channel` breaks with "Entity metadata for
Channel#videos was not found". Use the shared `ALL_ENTITIES` from
`src/test/create-test-data-source.ts` and register new entities there.

**The e2e suite runs the queue under its own Redis prefix** (`QUEUE_PREFIX`,
set at the top of `test/videos.e2e-spec.ts`) and boots the worker inside the
test process. Without the prefix the `video-worker` container, which shares
this Redis, consumes the jobs the test enqueues and the test waits forever.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Storage and Queue Configuration

All of these live in `.env` (see `.env.example`) and are validated by
`src/config/env.validation.ts`.

| Variable | Purpose |
|----------|---------|
| `S3_ENDPOINT` | In-cluster endpoint the API and worker connect to (`http://minio:9000`) |
| `S3_PUBLIC_ENDPOINT` | Host used **only to sign URLs handed to clients** (`http://localhost:9000`) |
| `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | Credentials and bucket |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO, which has no virtual-host buckets |
| `VIDEO_MAX_SIZE_BYTES`, `VIDEO_PART_SIZE_BYTES`, `VIDEO_URL_EXPIRATION_SECONDS` | Upload limit, part size and signed-URL lifetime |
| `REDIS_HOST`, `REDIS_PORT` | Queue backend |
| `QUEUE_PREFIX` | Namespaces every queue key in Redis; the e2e suite overrides it |
| `VIDEO_JOB_ATTEMPTS`, `VIDEO_JOB_BACKOFF_MS` | Retry policy of `video.process` |

**The two endpoints are not interchangeable.** SigV4 signs the `Host` header,
so a URL signed for one host is invalid against the other. Server-side calls
use the internal client; anything handed to a browser is signed with the public
one. A test that needs to fetch a client-facing URL from inside the container
uses `src/test/signed-url.ts`, which connects to the internal endpoint while
still sending the signed public `Host`.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
