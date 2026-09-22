---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-18T17:16:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T14:28:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-18T17:24:37-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-18T17:24:37-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-18T17:24:37-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-18T17:24:37-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-18T17:16:04-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — _the phase block in `project-plan.md` names no subproject paths explicitly; the slice's TDs are all `Backend` / `Cross-layer` / `Repo-wide` and land in `nestjs-project/` plus the repo-level `compose.yaml`._

**Deferred subprojects:** `next-frontend/` — no capability bullet of this phase describes a screen; UI for upload/player arrives with phases 04/05.

**Sequencing notes:** `> Depende de: Fase 01, Fase 02`

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (`> Depende de: Fase 01`)
- **Phase 04:** Gerenciamento de Vídeos e Canal (`> Depende de: Fase 02, Fase 03`)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia da fila de processamento | pending | — | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Estratégia de upload de arquivos de até 10GB | pending | — | — |
| phase-03-videos/TD-03 | phase | Backend | Biblioteca cliente de object storage | pending | — | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Organização do storage e assinatura de URLs (endpoint interno vs público) | pending | — | — |
| phase-03-videos/TD-05 | phase | Repo-wide | Imagem do storage S3-compatível no Compose | pending | — | — |
| phase-03-videos/TD-06 | phase | Repo-wide | Topologia e runtime do worker de vídeo | pending | — | — |
| phase-03-videos/TD-07 | phase | Backend | Invocação do FFmpeg/ffprobe e leitura do arquivo original | pending | — | — |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de status do vídeo, falhas e consistência fila ↔ banco | pending | — | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Identificador da URL única do vídeo | pending | — | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Entrega do vídeo — streaming e download | pending | — | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Acesso a streaming e download nesta fase | pending | — | — |
| phase-03-videos/TD-12 | phase | Backend | Estratégia de testes para storage, fila e worker | pending | — | — |

_`Renders in` column omitted: no TD in the kept set sets the field explicitly._

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-06, phase-03-videos/TD-12 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-09 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-10, phase-03-videos/TD-11 |

## Decisions Detail

_No decided TDs yet — all 12 TDs of `phase-03-videos` carry `**Decision:** _[pending]_`. `/plan-resolve 03` fills them._

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). Race conditions are mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random opaque tokens in DB — revocability is important: when a user requests a new password reset, previous tokens should be invalidated. Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** `@nestjs-modules/mailer` — best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with Mailpit for local development without external dependencies. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. A simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` — native NestJS integration is decisive: the guard system allows scoping rate limiting per module via `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance, so in-memory storage is sufficient.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Opaque refresh tokens — since DB lookup is mandatory (TD-03), JWT signature adds no security value.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** A strict `[a-z0-9_]` allowlist is the simplest and most portable choice for URL-based handles: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** [condensed] Strict-BFF model — the Next.js Route Handler is the **only** caller of the NestJS API; sessions are cookie-based. The backend remains the auth authority.
**Libraries:** —

### phase-02-auth-frontend/TD-03

**Recommendation:** [condensed] Server-side token refresh lives in the BFF helper with single-flight semantics. Backend implication: the refresh endpoint must tolerate the rotation/grace-period contract of `phase-02-auth/TD-03`.
**Libraries:** —

### phase-02-auth-frontend/TD-05

**Recommendation:** [condensed] **All** mutations go through Route Handlers under `app/api/**` (not Server Actions) — a single BFF mutation surface, explicitly set as the precedent for Phases 03–07. Backend implication: the API is called server-to-server from Next.js, never directly from the browser.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** [condensed] Token-bearing email links are handled by RSC pages that own the token. Backend implication: token-consuming endpoints must be idempotent (email-client prefetch may hit the link before the user does).
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` é a única opção que preserva as decisões anteriores (`class-validator` em `phase-02-auth/TD-06`) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Runtime UI + artefato `openapi.json` exportado — o custo marginal é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para a integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI exposta apenas em dev/staging via env flag — alinha com a postura defensiva já estabelecida na fase 02 e não compromete consumidores legítimos (o `openapi.json` exportado cumpre o papel de spec consultável fora da UI).
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. (TD refs: phase-02-auth-frontend/TD-07) |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements the BFF route so the contract is ready when the chrome lands. (TD refs: phase-02-auth-frontend/TD-01, TD-05) |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. (TD refs: phase-02-auth-frontend/TD-07) |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | deferred_to_next_phase — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per rows above. (TD refs: phase-02-auth-frontend/TD-01, TD-04) |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| (empty on first assembly — plan-resolve appends rows as user marks capabilities) | | | |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Source: `.claude/skills/testing-guide-nestjs-project/SKILL.md` §3. Suffix contract: `*.spec.ts` (unit), `*.integration-spec.ts` (real DB/services), `*.e2e-spec.ts` (HTTP via supertest, in `nestjs-project/test/`). Integration and e2e suites share one database and must run with `--runInBand`._

### next-frontend

_Deferred subproject — no capability bullet of phase 03 describes a UI surface; testing requirements for the upload/player screens will be defined when those phases plan them._
