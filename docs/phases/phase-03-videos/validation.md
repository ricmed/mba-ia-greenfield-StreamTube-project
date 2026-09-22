---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 1
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-22T15:06:49-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T15:02:57-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Pré-cadastro não define quais metadados o cliente envia ao iniciar o upload"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Fase não declara se expõe leitura de status/metadados do vídeo (fronteira com fase 04)"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — tecnologia da fila de processamento"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — estratégia de upload de arquivos de até 10GB"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — biblioteca cliente de object storage"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — organização do storage e assinatura de URLs"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — imagem do storage S3-compatível no Compose"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — topologia e runtime do worker de vídeo"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — invocação do FFmpeg/ffprobe e leitura do original"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — ciclo de status, falhas e consistência fila ↔ banco"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — identificador da URL única do vídeo"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — entrega do vídeo (streaming e download)"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — acesso a streaming e download nesta fase"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — estratégia de testes para storage, fila e worker"
    resolved_by: phase-03-videos/TD-12
  - id: ICC-1
    status: open
    summary: "TD-10/TD-11 expõem endpoints chamados pelo browser vs BFF estrito herdado da fase 02"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — Os TDs de entrega desta fase, agora decididos, colidem com uma convenção herdada da Fase 02. De um lado, `phase-03-videos/TD-10` (**B — `302` para presigned GET**) e `phase-03-videos/TD-11` (**A — stream e download públicos para vídeos `ready`**) desenham endpoints da API NestJS feitos para o browser chamar diretamente: a tag `<video>` aponta para o endpoint de stream, recebe o `302` e segue para o storage. Do outro lado, os herdados `phase-02-auth-frontend/TD-01` ("o Route Handler do Next.js é o **único** chamador da API NestJS") e `phase-02-auth-frontend/TD-05` ("a API é chamada server-to-server pelo Next.js, **nunca diretamente do browser**", declarado explicitamente como precedente para as **Fases 03–07**).

  Nota: a exceção registrada em OQ-2/OQ-10 cobria apenas os **bytes** trafegando direto entre browser e storage, com as chamadas de controle permanecendo na API. O ponto aberto aqui é diferente e mais estreito: **quem chama o endpoint de entrega da API** — o browser ou o BFF. Isso define a forma do contrato desta fase, e não pode ficar implícito.

  Explicit choice: (a) **manter TD-10/TD-11 e registrar a exceção à convenção herdada**, admitindo que endpoints públicos de mídia (stream/download) são chamados direto pelo browser, com o BFF estrito seguindo válido para tudo que é autenticado — a exceção fica anotada como restrição herdada para as fases 04–07; (b) **mudar a forma do contrato de entrega** para que o BFF resolva a URL: o endpoint da API devolve JSON com a URL presigned em vez de `302`, o Route Handler do Next.js a repassa ao player, e só o storage é acessado direto pelo browser — preserva a convenção herdada ao custo de um passo a mais e de mudar TD-10; (c) **abrir uma revisão da convenção herdada** via `/decide`, ajustando `phase-02-auth-frontend/TD-01`/`TD-05` para declararem que a regra vale para chamadas autenticadas, e não para entrega pública de mídia.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Pré-cadastro do vídeo: o cliente envia **`title` obrigatório** ao iniciar o upload, junto com `filename`, `size_bytes` e `mime_type`. Consequências para o `plan-build`: a coluna de título nasce `NOT NULL` no Data Model, e o corpo do endpoint de início de upload exige `title`. A Fase 04 passa a **editar** um título que já existe, em vez de preencher um vazio.
- **AMB-2** _(resolved_by clarification)_ — A Fase 03 **expõe uma consulta pontual por vídeo** (`GET` pelo identificador público do TD-09), devolvendo status editorial, status de processamento, duração, metadados e thumbnail. É o mínimo para observar o ciclo de status do TD-08 e para os testes e2e do TD-12. **Listagem por canal e painel de gerenciamento permanecem fora do escopo** — são capacidades da Fase 04.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Fila: **A (BullMQ + Redis via `@nestjs/bullmq`)**.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Upload de 10GB: **C (multipart presigned direto ao storage)**. A exceção à convenção de BFF herdada da Fase 02 é consciente e restrita aos bytes; as chamadas de controle (iniciar, assinar partes, concluir, abortar) continuam passando pela API.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Cliente de storage: **A (AWS SDK v3)**.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Storage e URLs: **A (bucket privado único + endpoints interno e público)**.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Imagem do storage: **A (MinIO da Chainguard, fixado por digest)**.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Worker: **A (mesmo codebase, entrypoint e container próprios)**.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — FFmpeg: **A (binários do sistema via `execFile`, lendo o original por URL presigned interna)**.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Ciclo de status: **B (`status` editorial + `processing_status` técnico)**.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — URL única: **B (ID curto de 64 bits via `node:crypto`, com `UNIQUE` e retry)**.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Entrega: **B (`302` para presigned GET, com `Range`/`206` nativo do storage)**.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Acesso: **A (público para vídeos `ready`, via ID não adivinhável)**. A restrição de visibilidade editorial fica registrada como trabalho da Fase 04.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — Testes: **A (infra real do Compose + worker instanciado no processo do teste)**.
