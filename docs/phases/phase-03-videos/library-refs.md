---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-22T15:10:00-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-09-22T16:05:00-03:00"
  "bullmq":
    version: "^6.3.8"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-09-22T15:10:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1137.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-22T15:10:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1137.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-22T15:10:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T15:20:15-03:00"
---

# phase-03-videos — Library References

_Compatibilidade verificada em 2026-09-22 dentro do container (`npm view`), com duas correções aplicadas durante o SI-03.7:_

- **`@nestjs/bullmq` fixado em `^11.0.5`, não `^12`.** A v12 declara `"type": "module"` (ESM puro) e o runtime CommonJS do Jest não consegue carregá-la (`SyntaxError: Unexpected token 'export'`). A 11.0.5 é CommonJS e mantém os mesmos peers relevantes: `@nestjs/core`/`@nestjs/common` `^10 || ^11` (o projeto tem 11.1.16) e `bullmq ^3 || ^4 || ^5 || ^6`.
- **`ioredis` precisa ser dependência explícita.** O `bullmq@6` transformou `ioredis` em peer **opcional** (era dependência direta na v5); sem instalá-lo, qualquer `Queue` falha no boot com "BullMQ could not load the optional 'ioredis' package" — em produção, não só nos testes.

Os pacotes do AWS SDK v3 seguem versionamento conjunto (3.1137.0).

## @nestjs/bullmq

_Usado por `phase-03-videos/TD-01` (fila) e `TD-06` (worker)._

**Registro do módulo** — `forRootAsync` para a conexão com o Redis (alinhado ao padrão `registerAs` + `ConfigType` herdado da fase 01) e `registerQueue` por fila:

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    },
  }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

**Processor** — classe decorada com `@Processor` estendendo `WorkerHost`, implementando `process(job)`. Opções do worker (inclusive `concurrency` e `maxStalledCount`) vão no segundo argumento do decorator:

```typescript
@Processor('video-processing', { concurrency: 2 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) { /* ... */ }
}
```

`@OnWorkerEvent('completed' | 'failed' | ...)` declara handlers de evento dentro da própria classe do processor — é o gancho usado pelos testes do TD-12 para esperar o fim do job de forma determinística, em vez de polling.

**Producer** — `@InjectQueue('video-processing') private queue: Queue` e `queue.add(name, data, opts)`. O `jobId` customizado vai em `opts` (ver bullmq abaixo).

## bullmq

_Usado por `phase-03-videos/TD-01` (retries/backoff) e `TD-08` (idempotência e falhas)._

- **Requisito do Redis:** `maxmemory-policy` deve ser `noeviction`; é a única configuração que garante o comportamento correto da fila. Recomendada também persistência AOF.
- **Conexão do worker:** `maxRetriesPerRequest: null` para que os comandos sejam repetidos indefinidamente enquanto o Redis estiver indisponível, em vez de derrubar o worker numa instabilidade momentânea.
- **Deduplicação:** `queue.add(name, data, { jobId: customJobId })`. É o mecanismo que o TD-08 usa com `jobId = videoId` para tornar o reenfileiramento idempotente.
- **Shutdown gracioso:** `await worker.close()` para de aceitar jobs novos e espera os ativos terminarem. A documentação recomenda tratar `SIGINT` e `SIGTERM` — no Nest, isso vem de `app.enableShutdownHooks()` no entrypoint do worker.
- **Jobs travados (stalled):** acontecem quando o worker não renova o lock por bloqueio do event loop. Não é risco aqui porque o FFmpeg roda como processo filho (TD-07), deixando o event loop livre.

## @aws-sdk/client-s3

_Usado por `phase-03-videos/TD-03` (cliente), `TD-02` (multipart), `TD-04` (layout) e `TD-10` (entrega)._

**Cliente apontando para storage S3-compatível** (padrão exigido pelo MinIO do TD-05):

```typescript
new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

**Multipart (TD-02):** `CreateMultipartUploadCommand` (exige `Bucket` e `Key`; devolve `UploadId`) → `UploadPartCommand` por parte → `CompleteMultipartUploadCommand` com a lista de `{ PartNumber, ETag }` → `AbortMultipartUploadCommand` no cancelamento. `HeadObjectCommand` confere o tamanho final.

**Range (TD-10):** `GetObjectCommand` aceita `Range: 'bytes=0-9'` e a resposta traz `AcceptRanges`, `ContentLength` (tamanho da faixa) e `ContentRange` (`bytes 0-9/43`) — é o suporte nativo que dispensa implementar `206` na API.

**Download (TD-10):** `GetObjectRequest.ResponseContentDisposition` define o nome do arquivo baixado e pode ser assinado na URL.

_Nota:_ `@aws-sdk/lib-storage` (classe `Upload`) resolve multipart **server-side**, com os bytes passando pelo processo. Não serve ao TD-02, que exige upload direto do cliente; fica fora do escopo.

## @aws-sdk/s3-request-presigner

_Usado por `phase-03-videos/TD-02` (URLs de parte), `TD-04` (endpoint público) e `TD-10` (entrega)._

```typescript
const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

- `expiresIn` é em segundos e **o padrão é 900** (15 min) quando omitido — os TDs preveem 1h, então o valor é sempre explícito.
- O teto do S3 para `X-Amz-Expires` é 604800 segundos (7 dias).
- A assinatura SigV4 inclui o header `host` (`X-Amz-SignedHeaders=host`), então a URL só vale no host com que foi assinada. É exatamente a razão do TD-04 manter dois clientes: um com `S3_ENDPOINT` (interno, para operações server-side) e outro com `S3_PUBLIC_ENDPOINT` (apenas para assinar URLs entregues ao cliente).
- Headers `x-amz-*` que precisem ser assinados vão em `unhoistableHeaders`.
