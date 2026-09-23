---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-22T15:22:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T15:20:15-03:00"
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
    status: resolved
    summary: "TD-10/TD-11 expõem endpoints chamados pelo browser vs BFF estrito herdado da fase 02"
    resolved_by: phase-03-videos/TD-10
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

_None._

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
- **ICC-1** _(resolved_by phase-03-videos/TD-10)_ — Mantidos TD-10 (`302`) e TD-11 (acesso público) com **exceção explícita registrada** à convenção de BFF estrito herdada (`phase-02-auth-frontend/TD-01` e `TD-05`): endpoints públicos de mídia são chamados direto pelo browser; o BFF estrito segue valendo para toda chamada autenticada. A exceção foi gravada como bloco `**Revisions:**` em TD-10 e TD-11, e as fases 04–07 a herdam junto com a regra de visibilidade editorial.
