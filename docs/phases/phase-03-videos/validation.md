---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 14
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-22T14:52:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T14:28:40-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Pré-cadastro não define quais metadados o cliente envia ao iniciar o upload"
  - id: AMB-2
    status: open
    summary: "Fase não declara se expõe leitura de status/metadados do vídeo (fronteira com fase 04)"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — tecnologia da fila de processamento"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — estratégia de upload de arquivos de até 10GB"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — biblioteca cliente de object storage"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — organização do storage e assinatura de URLs"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — imagem do storage S3-compatível no Compose"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — topologia e runtime do worker de vídeo"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — invocação do FFmpeg/ffprobe e leitura do original"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — ciclo de status, falhas e consistência fila ↔ banco"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — identificador da URL única do vídeo"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — entrega do vídeo (streaming e download)"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — acesso a streaming e download nesta fase"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — estratégia de testes para storage, fila e worker"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

_(Check 1 encontrou zero contradições: nenhum TD da fase está decidido ainda, todo `Capability:` cita um bullet presente em `## Scope`, e nenhum TD tem `Scope: Frontend` — logo não há risco de TD órfão no artefato final.)_

### Ambiguities

- **AMB-1** — O bullet "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" não diz **quais metadados o cliente informa no início do upload**. O `Data Model` da fase precisa de um título (coluna não-nula?), mas "Edição das informações do vídeo: título, descrição, categoria" é capacidade da **Fase 04**, e no instante do pré-cadastro só existe o arquivo. Três leituras plausíveis, com impacto direto em Data Model e API Contracts: (a) o cliente envia `title` obrigatório ao iniciar o upload; (b) o título é derivado do nome do arquivo enviado (`filename`), e a edição fica para a Fase 04; (c) o título nasce nulo/vazio e só a Fase 04 o preenche. Explicit choice: decidir qual leitura vale e registrar como TD (ou como nota de escopo) antes do `plan-build`, já que ela define colunas obrigatórias da tabela e o corpo do endpoint de início de upload.

- **AMB-2** — Os bullets da fase descrevem escrita (upload, processamento) e entrega (streaming, download), mas **não declaram um endpoint de leitura** dos dados do vídeo. Ainda assim, o ciclo de status (`draft` + `uploading → processing → ready | failed`) só é observável por quem consome a API se existir uma consulta, e os próprios entregáveis ("processamento automático do vídeo") dependem de alguém conseguir verificar o resultado. Por outro lado, "Painel de gerenciamento de vídeos do canal" é capacidade da **Fase 04**, então há risco real de invadir a fase seguinte. Explicit choice: decidir se a Fase 03 expõe (a) uma consulta pontual por vídeo (`GET` por identificador público, devolvendo status, duração, metadados e thumbnail) como suporte mínimo ao ciclo de status, ou (b) nenhuma leitura, deixando toda consulta para a Fase 04 — e, nesse caso, definir como os testes e o cliente observam a transição para `ready`. Listagem por canal permanece fora do escopo nas duas leituras.

### Missing Decisions

_None._

_(Check 3: todos os 9 bullets de `## Capability Coverage` têm ≥1 TD; o formato de erro HTTP já vem decidido por `phase-02-auth/TD-07` (herdado); e o sub-tipo "shared-types contract sync" (Decisão #29) não dispara porque a fase não tem escopo de UI ativo.)_

### Dependency Gaps

_None._

_(Check 4: os pré-requisitos das capacidades já estão entregues pelas fases anteriores — entidade `Channel` com relação 1:1 com `User`, guard JWT global, filtro de exceções de domínio, `ConfigModule` com namespaces + Joi e migrations versionadas. Storage, fila e worker são infraestrutura nova, criada dentro desta fase, e não dependência de fase anterior. A ordenação interna está declarada nos próprios TDs — TD-02 depende de TD-03/TD-04; TD-06 depende de TD-01/TD-07; TD-10 depende de TD-03/TD-04; TD-11 depende de TD-08/TD-09/TD-10.)_

### Inherited Constraint Conflicts

_None._

_(Check 5 avalia TDs **decididos** da fase corrente contra convenções e TDs herdados. Como os 12 TDs estão pendentes, nada pode ser confrontado ainda. Duas tensões a observar quando as decisões forem tomadas no `/plan-resolve` estão anotadas nos OQ-2, OQ-10 e OQ-11 abaixo, para não se perderem.)_

### Unresolved Open Questions

- **OQ-1** — `phase-03-videos/TD-01` pending — tecnologia da fila de processamento (recomendação: BullMQ + Redis via `@nestjs/bullmq`). Resolution: decidir via `/plan-resolve 03`, que preenche o campo `**Decision:**` do TD em `docs/decisions/technical-decisions-phase-03-videos.md` e depois re-rodar `/plan-validate 03`.
- **OQ-2** — `phase-03-videos/TD-02` pending — estratégia de upload de até 10GB (recomendação: multipart presigned direto ao storage). Observação para a decisão: a opção recomendada faz o **browser enviar bytes direto ao storage**, o que convive com — mas não é idêntico a — a convenção herdada `phase-02-auth-frontend/TD-05` ("todas as mutações passam por Route Handlers do BFF"); vale confirmar que a exceção é consciente e restrita aos bytes (as chamadas de controle continuam pela API). Resolution: decidir via `/plan-resolve 03`.
- **OQ-3** — `phase-03-videos/TD-03` pending — biblioteca cliente de object storage (recomendação: AWS SDK v3). Resolution: decidir via `/plan-resolve 03`.
- **OQ-4** — `phase-03-videos/TD-04` pending — organização do storage e assinatura de URLs, endpoint interno vs público (recomendação: bucket privado único + dois endpoints). Resolution: decidir via `/plan-resolve 03`.
- **OQ-5** — `phase-03-videos/TD-05` pending — imagem do storage S3-compatível no Compose (recomendação: MinIO da Chainguard, fixado por digest). Resolution: decidir via `/plan-resolve 03`.
- **OQ-6** — `phase-03-videos/TD-06` pending — topologia e runtime do worker (recomendação: mesmo codebase, entrypoint e container próprios). Resolution: decidir via `/plan-resolve 03`.
- **OQ-7** — `phase-03-videos/TD-07` pending — invocação do FFmpeg/ffprobe e leitura do original (recomendação: binários do sistema via `execFile` + URL presigned interna). Resolution: decidir via `/plan-resolve 03`.
- **OQ-8** — `phase-03-videos/TD-08` pending — ciclo de status, falhas e consistência fila ↔ banco (recomendação: `status` editorial + `processing_status` técnico). Observação: esta decisão é pré-requisito de AMB-1, porque fixa quais colunas de estado a tabela terá. Resolution: decidir via `/plan-resolve 03`.
- **OQ-9** — `phase-03-videos/TD-09` pending — identificador da URL única (recomendação: ID curto de 64 bits via `node:crypto` + `UNIQUE` + retry). Resolution: decidir via `/plan-resolve 03`.
- **OQ-10** — `phase-03-videos/TD-10` pending — entrega do vídeo, streaming e download (recomendação: `302` para presigned GET, com `Range`/`206` nativo do storage). Observação para a decisão: a opção recomendada segue a relação `Frontend → Object Storage: Streams` do diagrama de arquitetura, mas também entrega bytes fora do BFF — mesma tensão registrada em OQ-2. Resolution: decidir via `/plan-resolve 03`.
- **OQ-11** — `phase-03-videos/TD-11` pending — acesso a streaming e download nesta fase (recomendação: público para vídeos `ready`, via ID não adivinhável). Observação: a decisão define se a Fase 04 herda a restrição de visibilidade como trabalho novo; se for escolhida a alternativa "apenas o dono", é preciso decidir junto como o elemento `<video>` autentica, já que ele não envia header `Authorization`. Resolution: decidir via `/plan-resolve 03`.
- **OQ-12** — `phase-03-videos/TD-12` pending — estratégia de testes para storage, fila e worker (recomendação: infra real do Compose + worker no processo do teste). Resolution: decidir via `/plan-resolve 03`.

### UI Coverage Gaps

_None._

_(Check 7 não se aplica: nenhum bullet da Fase 03 descreve tela, a seção `## UI Inventory` não existe no `context.md` e o frontend está diferido desde a Fase 01.)_

## Resolved Issues

_No issues resolved yet._
