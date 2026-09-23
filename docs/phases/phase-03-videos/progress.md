# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/14 completed

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
- **Status:** completed
- **Tests:** 21/21 passing (videos.service.spec.ts 10, videos.e2e-spec.ts 11)
- **Observations:**
  - O intervalo de `part_numbers` (1..10000, teto real do S3) é validado no DTO, e não no service: o filtro de validação só transforma `BadRequestException` em `VALIDATION_ERROR`, e a regra do projeto proíbe serviços lançarem exceções HTTP do Nest.
  - O teto por vídeo (`part_count`) não é validado: assinar um número de parte não usado é inócuo, e o `CompleteMultipartUpload` valida o conjunto real. Estreitamento consciente do contrato.
  - `findOwnedVideoOrFail` e `assertUploadInProgress` nasceram privados aqui e são reutilizados por SI-03.8 (complete/abort).
  - O e2e envia bytes de verdade para a URL assinada e confere o `ETag` devolvido — é o que prova que a URL é utilizável pelo cliente.

### SI-03.7 — Fila de processamento: BullMQ, Redis e producer
- **Status:** completed
- **Tests:** 4/4 passing (video-processing.producer.integration-spec.ts 3, videos.module.spec.ts 1)
- **Observations:**
  - **Duas correções de dependência, ambas descobertas por teste vermelho.** (1) `@nestjs/bullmq@12` é ESM puro e o runtime CommonJS do Jest não a carrega; fixado em `^11.0.5` (CJS, mesmos peers). (2) `bullmq@6` tornou `ioredis` peer **opcional**, então ele virou dependência explícita — sem isso a fila nem inicializa, em produção também. `library-refs.md` foi atualizado com as duas.
  - Corrigido de passagem um erro de `tsc` que eu havia introduzido no SI-03.2: `ConfigType` precisa de `import type` com `isolatedModules` + `emitDecoratorMetadata`. `npx tsc --noEmit` agora sai com 0.
  - O teste do producer limpa a fila com `obliterate` entre casos; a fila é compartilhada com o dev, e não isolada por prefixo. Aceitável porque em dev o worker consome os jobs, mas fica anotado.
  - Follow-up fora de escopo: `videos.module.spec.ts` leva ~51s e abre conexões reais, o que pelo contrato de sufixos seria `.integration-spec.ts`. Mantido como `.spec.ts` por ser o padrão já estabelecido pelos módulos da fase 02 (auth, channels, users).

### SI-03.8 — Conclusão e cancelamento do upload
- **Status:** completed
- **Tests:** 39/39 passing (videos.service.spec.ts 17, videos.service.integration-spec.ts 5, videos.e2e-spec.ts 17)
- **Observations:**
  - As chamadas ao storage ficam **fora** de transação do banco; a mudança de estado é um único `save` (atômico por si) e o enqueue vem depois. O plano descrevia tudo "em transação", mas segurar uma transação do Postgres aberta durante I/O externo (complete + head no S3) prenderia conexão por segundos. Há teste garantindo a ordem `save` → `enqueue`.
  - Idempotência: chamar complete de novo num vídeo já em `processing` apenas reenfileira (dedup por `jobId`), sem refazer o `CompleteMultipartUpload`.
  - **Limitação conhecida do caminho 422:** quando o tamanho não bate, o vídeo permanece em `uploading` conforme o contrato, mas o multipart já foi consumido pelo `CompleteMultipartUpload` — o cliente precisa iniciar um upload novo. O e2e documenta o estado (assinar parte ainda responde 200).

### SI-03.9 — Worker de vídeo: entrypoint, processor e FFmpeg
- **Status:** completed
- **Tests:** 11/11 passing (ffmpeg.service.integration-spec.ts 4, video.processor.integration-spec.ts 6, worker.module.spec.ts 1)
- **Observations:**
  - **Bug de produção pego pelo teste:** o `WorkerModule` usava `autoLoadEntities: true`, mas o contexto do worker só registra `Video` via `forFeature`; a relação `Video → Channel → User` não resolvia e o `DataSource` morria no boot. Corrigido com lista explícita `entities: [Video, Channel, User]`. Verificado no container: `TypeOrmCoreModule dependencies initialized` agora passa e o worker loga "consuming the processing queue".
  - O `video-worker` do Compose deixou de rodar `tail -f` e passou a executar `npm run start:worker:dev` (scripts `start:worker` e `start:worker:dev` adicionados). `RestartCount=0` após 9 minutos.
  - Arquivo inválido usa `UnrecoverableError` do BullMQ: marca `failed` e **não** gasta as 3 tentativas. Erros transitórios continuam repetindo, e o `@OnWorkerEvent('failed')` só persiste a falha na última tentativa.
  - Fixtures de vídeo são geradas em tempo de teste via `ffmpeg -f lavfi` (`src/test/video-fixture.ts`), sem binário versionado no repositório.
  - **Follow-ups fora de escopo:** (1) o Jest não encerra após as suítes de integração (provável handle aberto de Redis/TypeORM), deixando processos órfãos no container; (2) o primeiro boot do worker leva ~6,5 min compilando no bind mount do Windows.

### SI-03.10 — GET /videos/:publicId: consulta do vídeo e do ciclo de status
- **Status:** completed
- **Tests:** 95/95 passing na rodada (videos.service.spec.ts + jwt-auth.guard.spec.ts = 28; videos.e2e-spec.ts + auth.e2e-spec.ts = 67)
- **Observations:**
  - **Mudança em código compartilhado da fase 02:** o `JwtAuthGuard` passou a resolver o token em rotas `@Public()` quando ele existe e é válido (best-effort), sem passar a exigi-lo. Era o único jeito de atender "resolução opcional do usuário" que o plano pede, já que o guard retornava antes de popular `request.user`. Rodei a suíte de auth inteira como regressão: 67 e2e verdes, nenhum 401/200 alterado.
  - Rascunho de terceiro e id inexistente devolvem **respostas idênticas** (404 VIDEO_NOT_FOUND) — há teste comparando os dois corpos, porque um 403 confirmaria a existência do ID.
  - O e2e marca o vídeo como `ready` direto no banco em vez de esperar o worker; o fluxo com worker real é o escopo do SI-03.13.

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
