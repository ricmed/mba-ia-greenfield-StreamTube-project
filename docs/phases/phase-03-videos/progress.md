# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/14 completed

### SI-03.1 — Infraestrutura: dependências, configuração e serviços no Compose
- **Status:** completed
- **Tests:** 13/13 passing (env.validation.integration-spec.ts)
- **Observations:**
  - Imagem do MinIO fixada por digest `sha256:a3c8509…` (tier gratuito da Chainguard só publica a tag `latest`). Ao contrário do que a página da imagem indica, ela **tem** shell e traz o `mc`, então o healthcheck usa `mc ready local` em vez de um probe externo.
  - O serviço `video-worker` sobe com `tail -f /dev/null` por enquanto; o comando passa a rodar o entrypoint real em SI-03.9, quando ele existir.
  - `requiredEnv` do spec de validação precisou ganhar as chaves S3 obrigatórias, senão os casos pré-existentes de SWAGGER_ENABLED quebrariam.
  - Limites do schema Joi ancorados nos limites reais do S3: parte entre 5 MiB e 5 GiB, expiração de URL até 604800s (7 dias).

### SI-03.2 — StorageModule: cliente S3 e operações de object storage
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Entidade Video e migration CreateVideos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — VideosModule, exceções de domínio e geração do public_id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — POST /videos: pré-cadastro do rascunho e início do multipart
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
