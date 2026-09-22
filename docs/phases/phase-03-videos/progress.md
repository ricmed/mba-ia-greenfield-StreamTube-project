# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/14 completed

### SI-03.1 — Infraestrutura: dependências, configuração e serviços no Compose
- **Status:** completed
- **Tests:** 13/13 passing (env.validation.integration-spec.ts)
- **Observations:**
  - Imagem do MinIO fixada por digest `sha256:a3c8509…` (tier gratuito da Chainguard só publica a tag `latest`). Ao contrário do que a página da imagem indica, ela **tem** shell e traz o `mc`, então o healthcheck usa `mc ready local` em vez de um probe externo.
  - O serviço `video-worker` sobe com `tail -f /dev/null` por enquanto; o comando passa a rodar o entrypoint real em SI-03.9, quando ele existir.
  - `requiredEnv` do spec de validação precisou ganhar as chaves S3 obrigatórias, senão os casos pré-existentes de SWAGGER_ENABLED quebrariam.
  - Limites do schema Joi ancorados nos limites reais do S3: parte entre 5 MiB e 5 GiB, expiração de URL até 604800s (7 dias).

### SI-03.2 — StorageModule: cliente S3 e operações de object storage
- **Status:** completed
- **Tests:** 7/7 passing (storage.service.integration-spec.ts, storage.module.spec.ts)
- **Observations:**
  - Criado `src/test/signed-url.ts`: o teste conecta no endpoint interno enviando o header `Host` do endpoint público, mantendo a assinatura SigV4 válida. Sem isso, URLs assinadas para o cliente seriam inalcançáveis de dentro do container, e a alternativa seria mockar o presign — justamente o que TD-12 proíbe.
  - `PutBucketCors` é tolerado com warn: o MinIO responde NotImplemented e usa o CORS de servidor (`MINIO_API_CORS_ALLOW_ORIGIN` no compose); em S3 real a regra é aplicada de fato.
  - Teste de multipart usa partes de 5 MiB porque é o mínimo que o S3 aceita para partes não finais.

### SI-03.3 — Entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 7/7 passing (video.entity.integration-spec.ts, migrations.integration-spec.ts)
- **Observations:**
  - `size_bytes` é `bigint` no banco e o driver `pg` devolve string; a entidade tipa `string | null` para refletir isso, em vez de mentir com `number`.
  - O `down()` gerado já derruba os dois enums, e o spec de migrations passou a asseverar isso explicitamente — é a regressão que quebrou o baseline antes.
  - `cleanAllTables` (helper compartilhado) passou a apagar `videos` antes de `channels`, senão a FK bloqueia a limpeza nas demais suítes.
  - O teste de revert agora cobre a última migration (CreateVideos), não mais as de token, porque a ordem mudou.

### SI-03.4 — VideosModule, exceções de domínio e geração do public_id
- **Status:** completed
- **Tests:** 10/10 passing (public-id.util.spec.ts, videos.module.spec.ts)
- **Observations:**
  - O retry de colisão ficou como função pura (`persistWithUniquePublicId`) no util, e não dentro do service: assim o critério de aceite de colisão é testável no arquivo que o plano lista, sem inventar um spec fora do contrato.
  - O detector de unique violation do pg está duplicado entre `public-id.util.ts` e `channels.service.ts`. Fora do escopo desta fase extrair para `src/common/`; fica anotado como follow-up.
  - As 7 exceções novas foram acrescentadas ao `domain.exception.ts` existente, seguindo o formato herdado (`errorCode`, status, mensagem).

### SI-03.5 — POST /videos: pré-cadastro do rascunho e início do multipart
- **Status:** completed
- **Tests:** 13/13 passing (videos.service.spec.ts 5, videos.service.integration-spec.ts 2, videos.e2e-spec.ts 6)
- **Observations:**
  - `ChannelsService.findByUserId` foi adicionado ao módulo de canais, e não um acesso direto ao repositório de Channel pelo VideosService — respeita a regra de responsabilidade única do CLAUDE.md.
  - O `id` (uuid) é gerado na aplicação antes do insert, porque a `storage_key` é determinística (`videos/{id}/original`) e precisa existir antes do `CreateMultipartUpload`.
  - Compensação: se a persistência falhar depois do multipart aberto, o upload é abortado no storage, senão ficariam partes órfãs. Coberto por teste unitário.
  - Limites de tamanho/MIME ficam no service (413/415 do Error Catalog), não no DTO — no DTO virariam 400 e quebrariam o contrato da API.

### SI-03.6 — POST /videos/:publicId/upload/parts: assinatura de partes sob demanda
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Fila de processamento: BullMQ, Redis e producer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Conclusão e cancelamento do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Worker de vídeo: entrypoint, processor e FFmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — GET /videos/:publicId: consulta do vídeo e do ciclo de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Streaming e download via redirect presigned
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Documentação OpenAPI dos endpoints de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — E2E do fluxo completo: upload, processamento e entrega
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Documentação de IA e diagrama de arquitetura
- **Status:** pending
- **Tests:** —
- **Observations:** none
