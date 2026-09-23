---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-22T15:22:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-22T15:22:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T15:20:15-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo de vídeos do backend com a infraestrutura nova que ele exige — object storage S3-compatível, fila de processamento e worker FFmpeg subindo no Compose —, cobrindo upload de até 10GB direto ao storage sem passar pela API, pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático com extração de duração/metadados e geração de thumbnail, URL única por vídeo, reprodução via streaming sem download completo e download do arquivo.

---

## Step Implementations

### SI-03.1 — Infraestrutura: dependências, configuração e serviços no Compose

**Description:** Sobe storage, fila e worker como serviços reais do Compose e cria os namespaces de configuração que o resto da fase consome.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-03`), `@nestjs/bullmq` e `bullmq` (per `phase-03-videos/TD-01`) — versões fixadas em `library-refs.md`.
2. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` com `registerAs`, seguindo a convenção herdada de namespaces (`phase-01-configuracao-base/TD-03`); chaves de storage conforme `phase-03-videos/TD-04` (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`).
3. Estender `src/config/env.validation.ts` (Joi) com as chaves novas de storage, fila e limites de upload (`VIDEO_MAX_SIZE_BYTES`, `VIDEO_PART_SIZE_BYTES`, `VIDEO_URL_EXPIRATION_SECONDS`) e atualizar `.env.example`.
4. Adicionar ao `compose.yaml` os serviços `minio` (imagem Chainguard fixada por digest, per `phase-03-videos/TD-05`), `redis` (`--maxmemory-policy noeviction --appendonly yes`, per `library-refs.md → bullmq`) e `video-worker` (mesma imagem da API, comando do entrypoint do worker, per `phase-03-videos/TD-06`), com healthchecks e `depends_on`.
5. Instalar `ffmpeg` no `Dockerfile.dev` (per `phase-03-videos/TD-07`) — a mesma imagem serve API, worker e container de testes (per `phase-03-videos/TD-12`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: schema aceita as chaves novas e rejeita ausência/valor inválido | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `minio`, `redis` e `video-worker` com status `running`, além dos serviços já existentes.
- `docker compose exec redis redis-cli ping` responde `PONG` e o endpoint `/minio/health/live` do storage responde `200`.
- Subir a API sem uma das variáveis novas obrigatórias falha no boot com erro de validação do Joi nomeando a chave ausente.
- `ffmpeg -version` e `ffprobe -version` executam dentro do container da API e do worker.

---

### SI-03.2 — StorageModule: cliente S3 e operações de object storage

**Description:** Encapsula todo acesso ao object storage num módulo próprio, com os dois clientes que a assinatura SigV4 exige.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` provendo **dois** `S3Client`: um com `S3_ENDPOINT` (interno, operações server-side) e um com `S3_PUBLIC_ENDPOINT` (apenas para assinar URLs entregues ao cliente), ambos com `forcePathStyle` (per `phase-03-videos/TD-04`, `library-refs.md → @aws-sdk/client-s3`).
2. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `presignUploadParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGetObject` (com `ResponseContentDisposition` opcional) e `putObject` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-10`).
3. Criar bootstrap idempotente do bucket e da configuração de CORS expondo `ETag` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`) — executado via SDK, já que a imagem do storage não traz o cliente `mc` (per `phase-03-videos/TD-05`).
4. Registrar `StorageModule` no `AppModule` e exportar `StorageService` para consumo por `VideosModule` e pelo worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: multipart real contra o MinIO do Compose (create → presign → PUT → complete → head), presign de GET com `Range` e com `attachment`, abort | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test (DI wiring dos dois clientes) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — os namespaces de config e o serviço `minio` precisam existir.

**Acceptance criteria:**

- Subir a aplicação cria o bucket configurado quando ele não existe, e rodar duas vezes seguidas não falha.
- Uma URL presigned emitida para o endpoint público carrega esse host na assinatura, enquanto as operações server-side usam o host interno do Compose.
- Um objeto enviado em múltiplas partes pelo fluxo multipart fica íntegro: `headObject` devolve o tamanho somado das partes.
- Uma requisição com header `Range` à URL presigned de GET devolve `206` com `Content-Range`.

---

### SI-03.3 — Entidade Video e migration CreateVideos

**Description:** Materializa a tabela `videos` com as duas dimensões de estado e o vínculo com o canal.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todos os campos do `### Data Model`, os dois enums (`videos_status_enum`, `videos_processing_status_enum`) e a relação `ManyToOne` com `Channel` (`ON DELETE CASCADE`), seguindo o padrão de entidades da fase 02.
2. Adicionar `@OneToMany(() => Video, ...)` em `src/channels/entities/channel.entity.ts` — lado inverso da relação, sem alterar colunas existentes.
3. Gerar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate`, conferindo que o `down()` derruba a tabela **e** os dois tipos enum (a ausência desse drop foi a causa raiz do bug corrigido em `bugfix/baseline-green`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, defaults de `status`/`processing_status`, `NOT NULL` de `title`, cascade ao remover o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| migrations | Integration: a suíte de migrations existente cobre a nova tabela e continua idempotente | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — a stack precisa subir com a configuração nova.

**Acceptance criteria:**

- Rodar as migrations num banco limpo cria a tabela `videos` com índice único em `public_id` e FK para `channels`.
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única.
- Um vídeo inserido sem `title` é rejeitado pelo banco.
- Remover um canal remove em cascata os vídeos daquele canal.
- Reverter a última migration e reaplicá-la funciona sem erro de tipo enum já existente.

---

### SI-03.4 — VideosModule, exceções de domínio e geração do public_id

**Description:** Cria o esqueleto do módulo de vídeos com as peças que todos os endpoints seguintes reutilizam.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`, importando `StorageModule` e `ChannelsModule`, e registrá-lo no `AppModule`.
2. Criar `src/videos/public-id.util.ts` — 8 bytes de `node:crypto` em base64url (11 caracteres), sem dependência externa (per `phase-03-videos/TD-09`).
3. Adicionar as exceções de domínio do `### Error Catalog` em `src/common/exceptions/domain.exception.ts`, estendendo `DomainException` no mesmo formato da fase 02 (`phase-02-auth/TD-07`).
4. Criar `src/videos/videos.service.ts` com o gerador de `public_id` resiliente: retry em violação de unique (`23505`) até um teto, no mesmo padrão já usado por `ChannelsService` (per `phase-03-videos/TD-09`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `public-id.util.ts` | Unit: formato base64url, comprimento 11, ausência de colisão em amostra grande | `src/videos/public-id.util.spec.ts` |
| `VideosModule` | Unit: compilation test (DI wiring com Storage e Channels) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3 — o módulo depende do storage e da entidade.

**Acceptance criteria:**

- O gerador devolve identificadores de 11 caracteres restritos ao alfabeto `[A-Za-z0-9_-]`.
- Uma colisão simulada de `public_id` é reprocessada e a criação termina com sucesso usando outro identificador.
- Cada exceção nova expõe o `errorCode` e o status HTTP exatos do `### Error Catalog`.

---

### SI-03.5 — POST /videos: pré-cadastro do rascunho e início do multipart

**Description:** Entrega o pré-cadastro automático do vídeo como rascunho no instante em que o upload começa.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` com `title`, `filename`, `size_bytes` e `mime_type`, validados por `class-validator` conforme `### API Contracts → #### Validation Rules` (per `phase-02-auth/TD-06`).
2. Implementar `VideosService.createDraft` — resolve o canal do usuário autenticado via `ChannelsService` (sem acessar o repositório de outro domínio), grava o vídeo com `status=draft` e `processing_status=uploading`, e chama `createMultipartUpload` guardando o `upload_id` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`).
3. Criar `src/videos/videos.controller.ts` com `POST /videos`, devolvendo `id`, `title`, `status`, `processing_status` e o bloco `upload` com `upload_id`, `part_size` e `part_count` conforme `### API Contracts`.
4. Validar os limites de `### API Contracts`: acima de 10 GiB lança `FILE_TOO_LARGE`; `mime_type` fora de `video/*` lança `UNSUPPORTED_MEDIA_TYPE`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: cálculo de `part_count`, limites de tamanho e mime (repos e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: persistência do rascunho + multipart real iniciado no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos` | E2E: 201 com corpo válido, 400/413/415 nos inválidos, 401 sem token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4 — precisa do módulo, das exceções e do gerador de `public_id`.

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id` de 11 caracteres, `status: "draft"`, `processing_status: "uploading"` e `part_count` igual a `ceil(size_bytes / part_size)`.
- Após a chamada, existe no banco um vídeo vinculado ao canal do usuário autenticado, com `upload_id` preenchido.
- `POST /videos` com `size_bytes` acima de 10 GiB retorna `413` com `error: "FILE_TOO_LARGE"`.
- `POST /videos` com `mime_type` fora de `video/*` retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`.
- `POST /videos` sem `Authorization` retorna `401` e não cria registro algum.

---

### SI-03.6 — POST /videos/:publicId/upload/parts: assinatura de partes sob demanda

**Description:** Entrega ao cliente as URLs presigned por parte, que é o que permite enviar 10GB direto ao storage e retomar uploads.

**Technical actions:**

1. Criar `src/videos/dto/sign-upload-parts.dto.ts` com `part_numbers` (array de inteiros, máximo 1000 itens por chamada) conforme `### API Contracts → #### Validation Rules`.
2. Implementar `VideosService.signUploadParts` — confere posse do canal (`NOT_VIDEO_OWNER`), exige `processing_status=uploading` (`UPLOAD_NOT_IN_PROGRESS`) e delega a assinatura ao `StorageService` com o cliente **público** e expiração configurável (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`).
3. Adicionar o endpoint ao `VideosController`, devolvendo `parts[]` com `part_number`, `url` e `expires_at`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signUploadParts` | Unit: posse, estado inválido e limites de `part_numbers` | `src/videos/videos.service.spec.ts` |
| `POST /videos/:publicId/upload/parts` | E2E: 200 com URLs utilizáveis, 403 para não-dono, 409 fora de `uploading`, 404 para id inexistente | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 — só faz sentido sobre um rascunho com multipart iniciado.

**Acceptance criteria:**

- Pedir as partes `[1, 2]` de um upload em andamento retorna `200` com duas URLs distintas e `expires_at` no futuro.
- Enviar bytes com `PUT` para a URL devolvida grava a parte no storage e responde com um `ETag`.
- Um usuário autenticado que não é dono do canal do vídeo recebe `403` com `error: "NOT_VIDEO_OWNER"`.
- Pedir partes de um vídeo que já saiu de `uploading` retorna `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`.

---

### SI-03.7 — Fila de processamento: BullMQ, Redis e producer

**Description:** Materializa o container `Message Queue` do diagrama e o produtor do job de processamento.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` no `AppModule` injetando `queue.config` e definindo `defaultJobOptions` com `attempts: 3` e backoff exponencial (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`, `library-refs.md → @nestjs/bullmq`).
2. Registrar a fila `video-processing` via `BullModule.registerQueue` e criar `src/videos/video-processing.constants.ts` com os nomes de fila e de job.
3. Criar `src/videos/video-processing.producer.ts` — `@InjectQueue` + `enqueueProcessing(videoId)` usando `jobId = videoId` para idempotência (per `phase-03-videos/TD-08`, `### Events/Messages → video.process`).
4. Configurar a conexão com `maxRetriesPerRequest: null` nos consumidores, conforme exigido pelo BullMQ em produção (`library-refs.md → bullmq`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration: enfileira contra o Redis real e enfileirar duas vezes o mesmo `videoId` resulta em um único job | `src/videos/video-processing.producer.integration-spec.ts` |
| fila | Unit: compilation test do módulo com a fila registrada | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — depende do serviço `redis` e do namespace de config da fila.

**Acceptance criteria:**

- Enfileirar um job coloca na fila `video-processing` um item cujo payload é `{ "videoId": "<uuid>" }`.
- Enfileirar duas vezes o mesmo `videoId` mantém um único job pendente (deduplicação por `jobId`).
- Um job que falha é repetido até 3 tentativas com intervalos crescentes antes de ir para o estado de falha.

---

### SI-03.8 — Conclusão e cancelamento do upload

**Description:** Fecha o multipart, confere o arquivo enviado e dispara o processamento — é a fronteira entre upload e worker.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` com `parts[]` (`part_number` + `etag`) conforme `### API Contracts`.
2. Implementar `VideosService.completeUpload` — em transação: `completeMultipartUpload` → `headObject` conferindo `size_bytes` (`UPLOAD_SIZE_MISMATCH`) → `processing_status=processing` e `upload_id` limpo; **o enqueue acontece depois do commit**, e o endpoint é idempotente: um vídeo já em `processing` apenas reenfileira (per `phase-03-videos/TD-08`).
3. Implementar `VideosService.abortUpload` — `abortMultipartUpload` no storage e remoção do rascunho, exigindo `processing_status=uploading`.
4. Adicionar ao `VideosController` o `POST /videos/:publicId/upload/complete` e o `DELETE /videos/:publicId/upload` conforme `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: divergência de tamanho, estado inválido e idempotência do reenqueue | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: multipart real concluído no MinIO + transição de estado no banco + job na fila | `src/videos/videos.service.integration-spec.ts` |
| `POST .../upload/complete`, `DELETE .../upload` | E2E: 200 na conclusão, 204 no cancelamento, 409/422 nos caminhos de erro | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7 — precisa das partes enviadas e da fila disponível.

**Acceptance criteria:**

- Concluir um upload cujas partes foram enviadas retorna `200` com `processing_status: "processing"` e deixa o objeto íntegro no storage.
- Após a conclusão, existe exatamente um job `video.process` na fila para aquele vídeo.
- Chamar a conclusão duas vezes seguidas retorna `200` nas duas e mantém um único job na fila.
- Concluir declarando um tamanho diferente do que foi enviado retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"` e mantém o vídeo em `uploading`.
- `DELETE /videos/:publicId/upload` retorna `204`, remove o rascunho e nenhum job é enfileirado.

---

### SI-03.9 — Worker de vídeo: entrypoint, processor e FFmpeg

**Description:** Entrega o processamento automático — duração, metadados e thumbnail — num processo separado da API.

**Technical actions:**

1. Criar `src/worker.ts` (`NestFactory.createApplicationContext`, sem HTTP) e `src/videos/worker.module.ts` importando config, TypeORM, Storage e a fila — é o comando do serviço `video-worker` do Compose (per `phase-03-videos/TD-06`); habilitar shutdown hooks para o `worker.close()` gracioso (`library-refs.md → bullmq`).
2. Criar `src/videos/ffmpeg.service.ts` — `execFile` de `ffprobe -v error -print_format json -show_format -show_streams` e de `ffmpeg -ss <t> -frames:v 1`, ambos recebendo **URL presigned interna** do original, sem baixar o arquivo (per `phase-03-videos/TD-07`).
3. Criar `src/videos/video.processor.ts` (`@Processor('video-processing')` + `WorkerHost`): extrai duração e metadados, gera a thumbnail em ~10% da duração com largura máxima de 1280px, faz upload dela em `videos/{id}/thumbnail.jpg` e grava `processing_status=ready` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
4. Tratar falhas conforme `### Events/Messages`: arquivo que o ffprobe rejeita vai direto para `failed` sem retry; esgotadas as 3 tentativas, `failed` + `processing_error` preenchido.
5. Mapear o subconjunto de metadados persistidos (largura, altura, codecs, bitrate, formato do container) para a coluna `metadata` (`jsonb`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: ffprobe e extração de frame sobre fixture gerada por `ffmpeg -f lavfi` (per `phase-03-videos/TD-12`) | `src/videos/ffmpeg.service.integration-spec.ts` |
| `VideoProcessor` | Integration: job real leva o vídeo de `processing` a `ready` com duração, metadados e thumbnail no storage; arquivo inválido termina em `failed` com `processing_error` | `src/videos/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test do contexto do worker | `src/videos/worker.module.spec.ts` |

**Dependencies:** SI-03.8 — consome o job produzido na conclusão do upload.

**Acceptance criteria:**

- Um vídeo concluído passa a `processing_status: "ready"` com `duration_seconds` compatível com o arquivo enviado e `metadata` contendo largura, altura e codecs.
- Existe no storage um objeto em `videos/{id}/thumbnail.jpg` e o campo `thumbnail_key` aponta para ele.
- Um arquivo que não é vídeo termina em `processing_status: "failed"` com `processing_error` preenchido e sem novas tentativas.
- Reprocessar o mesmo vídeo sobrescreve metadados e thumbnail sem duplicar objetos no storage.
- O container `video-worker` processa o job sem que a API participe do processamento.

---

### SI-03.10 — GET /videos/:publicId: consulta do vídeo e do ciclo de status

**Description:** Torna o ciclo de status observável pela API, que é o que fecha o laço do processamento automático.

**Technical actions:**

1. Implementar `VideosService.findByPublicId` aplicando a regra de acesso do `### Authorization Matrix`: o dono enxerga qualquer estado; para os demais, vídeo que não está `ready` responde como inexistente (`VIDEO_NOT_FOUND`), sem vazar a existência do rascunho (per `phase-03-videos/TD-11`).
2. Criar `src/videos/dto/video-response.dto.ts` com os campos do `### API Contracts`, incluindo `thumbnail_url` assinada no endpoint público quando `thumbnail_key` existe (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`).
3. Adicionar `GET /videos/:publicId` ao `VideosController` com `@Public()` e resolução opcional do usuário autenticado para distinguir o dono.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findByPublicId` | Unit: dono vê rascunho, anônimo recebe not-found, `ready` é público | `src/videos/videos.service.spec.ts` |
| `GET /videos/:publicId` | E2E: 200 com metadados e `thumbnail_url` para `ready`; 404 para rascunho de terceiro e para id inexistente | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.9 — os campos de duração, metadados e thumbnail só existem após o processamento.

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com `duration_seconds`, `metadata` e uma `thumbnail_url` que responde `200` ao ser acessada.
- O dono consulta seu vídeo ainda em `processing` e recebe `200` com `processing_status: "processing"`.
- Um anônimo consultando um vídeo que não está `ready` recebe `404` com `error: "VIDEO_NOT_FOUND"`, indistinguível da resposta para um id inexistente.
- Um vídeo em `failed` consultado pelo dono expõe `processing_error`.

---

### SI-03.11 — Streaming e download via redirect presigned

**Description:** Entrega reprodução sem download completo e download do arquivo, sem que bytes de vídeo passem pela API.

**Technical actions:**

1. Implementar `VideosService.buildDeliveryUrl` — exige `processing_status=ready` (`VIDEO_NOT_READY`) e assina um GET de curta duração no endpoint público; para download, inclui `ResponseContentDisposition: attachment; filename="{original_filename}"` (per `phase-03-videos/TD-10`).
2. Adicionar `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` ao `VideosController`, ambos `@Public()` e respondendo `302` com `Location` e `Cache-Control: no-store` conforme `### API Contracts`.
3. Documentar no código a exceção registrada em `phase-03-videos/TD-10` e `TD-11`: endpoints públicos de mídia são chamados direto pelo browser, enquanto o BFF estrito segue valendo para chamadas autenticadas.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.buildDeliveryUrl` | Unit: bloqueio fora de `ready`, presença do `attachment` só no download | `src/videos/videos.service.spec.ts` |
| `GET .../stream`, `GET .../download` | E2E: 302 com `Location`, requisição com `Range` ao destino devolve `206` com `Content-Range`, download devolve `Content-Disposition` | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.10 — reaproveita a resolução do vídeo por `public_id`.

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `302` com `Location` apontando para o storage.
- Uma requisição com `Range: bytes=0-1023` à URL do `Location` retorna `206` com `Content-Range` e apenas o trecho pedido, sem baixar o arquivo inteiro.
- `GET /videos/:publicId/download` retorna `302` cuja URL entrega o arquivo com `Content-Disposition: attachment` e o nome original.
- Stream ou download de um vídeo que não está `ready` retorna `409` com `error: "VIDEO_NOT_READY"`.
- Nenhum byte do vídeo trafega pelo processo da API nos dois fluxos.

---

### SI-03.12 — Documentação OpenAPI dos endpoints de vídeo

**Description:** Estende o contrato OpenAPI já existente com os endpoints novos, mantendo o artefato exportado coerente.

**Technical actions:**

1. Anotar `VideosController` e os DTOs com `@ApiTags`, `@ApiOperation`, `@ApiResponse` e `@ApiProperty`, reutilizando `ApiErrorEnvelope` de `src/common/openapi/` (per `openapi-docs-nestjs/TD-01`).
2. Declarar as respostas de erro do `### Error Catalog` por endpoint, incluindo o `302` dos endpoints de entrega.
3. Regenerar `openapi.json` pelo script existente, mantendo o artefato versionado atualizado (per `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: o spec exportado contém os 7 endpoints de vídeo com seus códigos de resposta | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.11 — todos os endpoints precisam existir antes de documentá-los.

**Acceptance criteria:**

- O spec exportado lista os 7 endpoints de vídeo sob a tag do módulo.
- Cada endpoint declara seus códigos de erro do `### Error Catalog` com o envelope padrão do projeto.
- A UI do Swagger em ambiente de desenvolvimento exibe os endpoints novos sem erro de schema.

---

### SI-03.13 — E2E do fluxo completo: upload, processamento e entrega

**Description:** Exercita a fase inteira contra a infraestrutura real do Compose, sem mocks, incluindo o worker.

**Technical actions:**

1. Criar helpers em `src/test/`: geração de fixture de vídeo via `ffmpeg -f lavfi`, bucket e prefixo de fila isolados para teste, e cliente que alcança URLs presigned do endpoint público a partir de dentro do container enviando o header `Host` correspondente (per `phase-03-videos/TD-04`, `phase-03-videos/TD-12`).
2. Escrever `test/videos.e2e-spec.ts` cobrindo o fluxo ponta a ponta: registrar e autenticar, `POST /videos`, assinar partes, enviar as partes direto ao storage, concluir, aguardar o worker (instanciado no processo do teste, per `phase-03-videos/TD-12`) chegar a `ready`, consultar, fazer stream com `Range` e baixar.
3. Cobrir o caminho de falha: arquivo inválido termina em `failed` com `processing_error`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| fluxo da fase | E2E: upload multipart → processamento → `ready` → stream `206` → download | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.12 — fecha sobre a superfície completa já documentada.

**Acceptance criteria:**

- O teste percorre upload, processamento e entrega usando MinIO, Redis e FFmpeg reais, sem mock de storage ou de fila.
- A espera pelo processamento é determinística, baseada no evento de conclusão do job, e não em tempo fixo.
- O caminho de falha deixa o vídeo em `failed` com `processing_error` preenchido.
- A suíte roda com `--runInBand` e não deixa resíduo que quebre execuções seguintes.

---

### SI-03.14 — Documentação de IA e diagrama de arquitetura

**Description:** Alinha a documentação do repositório ao que a fase de fato entregou — exigência da Definition of Done do projeto.

**Technical actions:**

1. Atualizar o `CLAUDE.md` da raiz: trocar `Message Queue (TBD)` pela fila escolhida (per `phase-03-videos/TD-01`) e acrescentar a seção de vídeos com o fluxo upload → fila → worker → storage, o ciclo de status e os endpoints.
2. Atualizar `nestjs-project/CLAUDE.md`: serviços novos do Compose com seus probes de readiness, variáveis de ambiente de storage e fila, como rodar o worker e a dependência de ffmpeg nos testes.
3. Atualizar `docs/diagrams/software-arch.mermaid` substituindo o `TBD` do container de fila pela tecnologia decidida.

**Tests:** _(empty — documentação)_

**Dependencies:** SI-03.13 — a documentação descreve o comportamento já verificado.

**Acceptance criteria:**

- Nenhum arquivo, endpoint ou comando citado na documentação atualizada é inexistente no código da fase.
- O diagrama de arquitetura não contém mais o marcador `TBD` no container de fila.
- A documentação do backend descreve os três serviços novos do Compose e como verificar que estão prontos.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Duas dimensões de estado ortogonais por `phase-03-videos/TD-08`: `status` é editorial (a Fase 04 acrescenta `published`) e `processing_status` é técnico. `title` nasce `NOT NULL` porque o cliente o envia ao iniciar o upload (clarificação AMB-1 em `validation.md`). As chaves de storage são determinísticas por `phase-03-videos/TD-04`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(11) | unique, not null — ID curto base64url de 64 bits (`phase-03-videos/TD-09`) |
| channel_id | uuid | not null, FK → `channels(id)` ON DELETE CASCADE |
| title | varchar(255) | not null (AMB-1) |
| status | enum `videos_status_enum` (`draft`) | not null, default `draft` (`phase-03-videos/TD-08`) |
| processing_status | enum `videos_processing_status_enum` (`uploading`, `processing`, `ready`, `failed`) | not null, default `uploading` (`phase-03-videos/TD-08`) |
| processing_error | text | nullable — preenchido apenas em `failed` (`phase-03-videos/TD-08`) |
| storage_key | varchar(512) | not null — `videos/{id}/original` (`phase-03-videos/TD-04`) |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg`, preenchido pelo worker (`phase-03-videos/TD-04`) |
| upload_id | varchar(255) | nullable — `UploadId` do multipart; limpo no complete e no abort (`phase-03-videos/TD-02`) |
| original_filename | varchar(255) | not null (AMB-1) |
| mime_type | varchar(127) | not null — declarado pelo cliente, validado de fato pelo ffprobe (`phase-03-videos/TD-02`) |
| size_bytes | bigint | nullable — declarado no início, confirmado por `HeadObject` no complete (`phase-03-videos/TD-02`) |
| duration_seconds | integer | nullable — extraído pelo ffprobe (`phase-03-videos/TD-07`) |
| metadata | jsonb | nullable — largura, altura, codecs de vídeo/áudio, bitrate e formato do container (`phase-03-videos/TD-07`) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel_id` → `channels.id`, ON DELETE CASCADE)
**Indexes:** unique on `public_id`; index on `channel_id`; index on `processing_status`

### API Contracts

Somente o tier de backend: a fase não tem escopo de UI, então nenhum tier BFF é emitido. Todos os endpoints seguem o envelope de erro herdado (`phase-02-auth/TD-07`): `{ statusCode, error, message }`.

#### POST /videos (SI-03.5)

Cria o rascunho e inicia o multipart upload (`phase-03-videos/TD-02`). Nenhum byte de vídeo trafega neste endpoint.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — 1..255 caracteres (AMB-1)
- filename: string, required — 1..255 caracteres
- size_bytes: integer, required — 1..10737418240 (10 GiB, `phase-03-videos/TD-02`)
- mime_type: string, required — deve começar com `video/` (`phase-03-videos/TD-02`)

**Response 201:**
- id: string — o `public_id` de 11 caracteres (`phase-03-videos/TD-09`)
- title: string
- status: string — sempre `draft` na criação (`phase-03-videos/TD-08`)
- processing_status: string — sempre `uploading` na criação (`phase-03-videos/TD-08`)
- upload: object
  - upload_id: string — `UploadId` do multipart
  - part_size: integer — 67108864 (64 MiB, `phase-03-videos/TD-02`)
  - part_count: integer — `ceil(size_bytes / part_size)`

**Error responses:**
- 400 validation error: quando o corpo falha na validação de schema
- 413 FILE_TOO_LARGE: quando `size_bytes` excede 10 GiB
- 415 UNSUPPORTED_MEDIA_TYPE: quando `mime_type` não começa com `video/`
- 401: sem token de acesso válido (guard JWT global herdado)

---

#### POST /videos/:publicId/upload/parts (SI-03.6)

Assina URLs de `UploadPart` sob demanda, em lote (`phase-03-videos/TD-02`). É também o caminho de retomada quando as URLs expiram.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- part_numbers: integer[], required — 1..1000 itens, cada valor entre 1 e `part_count`

**Response 200:**
- parts: object[]
  - part_number: integer
  - url: string — URL presigned no endpoint público (`phase-03-videos/TD-04`)
  - expires_at: string (ISO-8601) — 1h após a emissão (`phase-03-videos/TD-02`)

**Error responses:**
- 400 validation error: quando `part_numbers` está ausente, vazio ou fora do intervalo
- 404 VIDEO_NOT_FOUND: quando não existe vídeo com o `publicId`
- 403 NOT_VIDEO_OWNER: quando o vídeo não pertence ao canal do usuário autenticado
- 409 UPLOAD_NOT_IN_PROGRESS: quando o vídeo não está em `processing_status=uploading`

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Conclui o multipart, confere o tamanho e enfileira o processamento (`phase-03-videos/TD-02`, `phase-03-videos/TD-08`). Idempotente: se o vídeo já está em `processing`, apenas garante o job enfileirado.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: object[], required — 1..10000 itens
  - part_number: integer, required
  - etag: string, required — o `ETag` devolvido pelo storage em cada parte

**Response 200:**
- id: string
- status: string — `draft`
- processing_status: string — `processing`

**Error responses:**
- 400 validation error: quando o corpo falha na validação de schema
- 404 VIDEO_NOT_FOUND / 403 NOT_VIDEO_OWNER
- 409 UPLOAD_NOT_IN_PROGRESS: quando o vídeo já saiu de `uploading` e não está em `processing`
- 422 UPLOAD_SIZE_MISMATCH: quando o `HeadObject` devolve tamanho diferente do declarado

---

#### DELETE /videos/:publicId/upload (SI-03.7)

Cancela o upload em andamento (`AbortMultipartUpload`) e descarta o rascunho (`phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND / 403 NOT_VIDEO_OWNER
- 409 UPLOAD_NOT_IN_PROGRESS: quando o vídeo não está em `processing_status=uploading`

---

#### GET /videos/:publicId (SI-03.10)

Consulta pontual dos dados do vídeo — é o que torna o ciclo de status observável (clarificação AMB-2). Listagem por canal é capacidade da Fase 04 e não entra aqui.

**Response 200:**
- id: string
- title: string
- status: string
- processing_status: string
- processing_error: string | null — presente apenas em `failed`
- duration_seconds: integer | null
- metadata: object | null
- thumbnail_url: string | null — URL presigned de GET, 1h (`phase-03-videos/TD-10`)
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando não existe vídeo com o `publicId`, ou quando o solicitante é anônimo e o vídeo ainda não está `ready` (não vaza a existência do rascunho)

---

#### GET /videos/:publicId/stream (SI-03.11)

Reprodução via streaming sem download completo (`phase-03-videos/TD-10`). A API não transporta bytes: responde `302` para uma URL presigned, e o storage atende `Range` com `206 Partial Content` nativamente.

**Response 302:**
- Location: URL presigned de `GetObject` no endpoint público, expiração de 1h (`phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
- Cache-Control: `no-store` — a URL é de curta duração

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe
- 409 VIDEO_NOT_READY: quando `processing_status` não é `ready`

---

#### GET /videos/:publicId/download (SI-03.11)

Mesmo mecanismo do stream, com `ResponseContentDisposition` (`phase-03-videos/TD-10`).

**Response 302:**
- Location: URL presigned de `GetObject` com `ResponseContentDisposition: attachment; filename="{original_filename}"`, expiração de 1h

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — módulo de vídeos

- `title`: obrigatório, 1..255 caracteres
- `filename`: obrigatório, 1..255 caracteres
- `size_bytes`: obrigatório, inteiro, 1..10737418240 (limite de 10 GiB configurável por env, `phase-03-videos/TD-02`)
- `mime_type`: obrigatório, deve casar com `^video/`
- `part_numbers`: obrigatório, array de inteiros ≥ 1, máximo 1000 itens por chamada
- `parts[].etag`: obrigatório, string não vazia
- Corpos rejeitam campos desconhecidos (`whitelist` + `forbidNonWhitelisted` do `ValidationPipe` global herdado)

### Authorization Matrix

`Anonymous` = sem `Authorization`; `Authenticated` = qualquer usuário com access token válido; `Owner` = usuário cujo canal é dono do vídeo. Base: guard JWT global herdado (`phase-02-auth/TD-02`) e `phase-03-videos/TD-11`.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:publicId/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (qualquer estado) |
| GET /videos/:publicId/stream | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |
| GET /videos/:publicId/download | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |

Notas: os três endpoints de entrega e consulta são `@Public()` por `phase-03-videos/TD-11` — o acesso é protegido pela imprevisibilidade do `public_id` de 64 bits, e a visibilidade editorial (público/unlisted) é capacidade da Fase 04. Os endpoints de upload exigem posse do canal; `Authenticated` sem posse recebe `403 NOT_VIDEO_OWNER`.

### Error Catalog

Formato herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }`, com `error` em SCREAMING_SNAKE emitido por uma subclasse de `DomainException` e traduzido pelo filtro global.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente, ou rascunho consultado por quem não é o dono |
| NOT_VIDEO_OWNER | 403 | Operação de upload sobre vídeo de outro canal |
| UPLOAD_NOT_IN_PROGRESS | 409 | Assinar partes, concluir ou abortar um upload que não está em `uploading` |
| UPLOAD_SIZE_MISMATCH | 422 | `HeadObject` após o complete devolve tamanho diferente do declarado |
| FILE_TOO_LARGE | 413 | `size_bytes` declarado acima do limite de 10 GiB |
| UNSUPPORTED_MEDIA_TYPE | 415 | `mime_type` declarado fora de `video/*` |
| VIDEO_NOT_READY | 409 | Stream ou download de vídeo que não está em `processing_status=ready` |

### Events/Messages

#### video.process

Job único da fila `video-processing` (`phase-03-videos/TD-01`). O `jobId` é o `id` interno do vídeo, o que torna o enfileiramento idempotente e dispensa deduplicação própria.

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`) — enfileira **depois** do commit da transação que move `processing_status` para `processing`; o endpoint de conclusão é idempotente e reenfileira quando encontra o vídeo já em `processing` sem job ativo.
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`) — roda no container `video-worker`, entrypoint separado do HTTP.
**Trigger:** conclusão bem-sucedida do multipart upload (`POST /videos/:publicId/upload/complete`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`) — `attempts: 3` com backoff exponencial; o processamento é idempotente por chaves determinísticas (`phase-03-videos/TD-04`), então reprocessar sobrescreve metadados e thumbnail. Esgotadas as tentativas, ou diante de arquivo que o ffprobe rejeita (erro não recuperável, sem retry), o vídeo termina em `processing_status=failed` com `processing_error` preenchido (`phase-03-videos/TD-08`).

---

## Dependency Map

```
SI-03.1 (root) — infraestrutura: deps, config, Compose (minio, redis, video-worker), ffmpeg
├── SI-03.2 — depends on SI-03.1 (storage precisa do serviço minio e do namespace de config)
│   └── SI-03.4 — depends on SI-03.2 + SI-03.3 (módulo consome storage e entidade)
│       └── SI-03.5 — depends on SI-03.4 (endpoint precisa do módulo e do gerador de public_id)
│           └── SI-03.6 — depends on SI-03.5 (assinar partes exige multipart iniciado)
│               └── SI-03.8 — depends on SI-03.6 + SI-03.7 (concluir exige partes enviadas e fila pronta)
│                   └── SI-03.9 — depends on SI-03.8 (worker consome o job da conclusão)
│                       └── SI-03.10 — depends on SI-03.9 (consulta expõe duração, metadados e thumbnail)
│                           └── SI-03.11 — depends on SI-03.10 (entrega reusa a resolução por public_id)
│                               └── SI-03.12 — depends on SI-03.11 (documenta a superfície completa)
│                                   └── SI-03.13 — depends on SI-03.12 (e2e fecha sobre tudo)
│                                       └── SI-03.14 — depends on SI-03.13 (docs descrevem o verificado)
├── SI-03.3 — depends on SI-03.1 (entidade e migration sobre a stack configurada)
└── SI-03.7 — depends on SI-03.1 (fila precisa do serviço redis e do namespace de config)
```

SI-03.2, SI-03.3 e SI-03.7 são independentes entre si e podem ser implementados em qualquer ordem depois de SI-03.1; a cadeia volta a ser serial a partir de SI-03.4.

---

## Deliverables

- [x] SI-03.1 — Infraestrutura: dependências, configuração e serviços no Compose
- [x] SI-03.2 — StorageModule: cliente S3 e operações de object storage
- [x] SI-03.3 — Entidade Video e migration CreateVideos
- [x] SI-03.4 — VideosModule, exceções de domínio e geração do public_id
- [x] SI-03.5 — POST /videos: pré-cadastro do rascunho e início do multipart
- [x] SI-03.6 — POST /videos/:publicId/upload/parts: assinatura de partes sob demanda
- [x] SI-03.7 — Fila de processamento: BullMQ, Redis e producer
- [x] SI-03.8 — Conclusão e cancelamento do upload
- [x] SI-03.9 — Worker de vídeo: entrypoint, processor e FFmpeg
- [x] SI-03.10 — GET /videos/:publicId: consulta do vídeo e do ciclo de status
- [x] SI-03.11 — Streaming e download via redirect presigned
- [x] SI-03.12 — Documentação OpenAPI dos endpoints de vídeo
- [x] SI-03.13 — E2E do fluxo completo: upload, processamento e entrega
- [x] SI-03.14 — Documentação de IA e diagrama de arquitetura

**Capacidades da fase (do `project-plan.md`):**

- [x] Object storage no Compose guardando vídeos e thumbnails (SI-03.1, SI-03.2)
- [x] Fila de processamento em segundo plano com worker dedicado (SI-03.1, SI-03.7, SI-03.9)
- [x] Upload de até 10GB sem que bytes passem pela API (SI-03.5, SI-03.6, SI-03.8)
- [x] Pré-cadastro do vídeo como rascunho ao iniciar o upload (SI-03.5)
- [x] Processamento automático com duração e metadados (SI-03.9)
- [x] Thumbnail gerada de um frame do vídeo (SI-03.9)
- [x] URL única por vídeo, sem conflito (SI-03.4)
- [x] Reprodução via streaming, com `Range`/`206`, sem download completo (SI-03.11)
- [x] Download do vídeo pelo usuário (SI-03.11)

**Full test suites** _(todos os comandos rodam dentro do container, per `nestjs-project/CLAUDE.md`)_:

- [x] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit`, exit 0)
- [x] Lint limpo (`docker compose exec nestjs-api npm run lint`)
- [x] Build compila (`docker compose exec nestjs-api npm run build`)
