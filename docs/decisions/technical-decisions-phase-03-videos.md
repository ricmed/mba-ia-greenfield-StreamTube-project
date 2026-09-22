---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-22
scope_description: "Backend foundation for video upload and processing: object storage (S3-compatible, MinIO locally), background job queue, FFmpeg video worker, direct-to-storage upload of files up to 10GB, draft pre-registration, automatic metadata extraction and thumbnail generation, unique video URL, streaming via HTTP range requests and user download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o módulo de vídeos (entidade, endpoints de upload/consulta/entrega), o cliente de object storage, o producer da fila e o worker de vídeo (entrypoint próprio, mesmo codebase — ver TD-06), além dos novos serviços no `compose.yaml` (storage, fila, worker).
- `next-frontend/` — Frontend deferred: a Fase 03 não tem bullet de tela em `docs/project-plan.md` (as telas de upload/player chegam com as fases 04/05). Os TDs `Cross-layer` abaixo (TD-02, TD-04, TD-09, TD-10, TD-11) fixam o contrato que o frontend consumirá depois, mas não há decisão aberta de implementação no `next-frontend/` neste documento.

_Decisões herdadas (não reabertas):_ config via `@nestjs/config` + Joi + namespaces `registerAs` (`phase-01-configuracao-base/TD-01..TD-04`); guard JWT customizado com `@nestjs/jwt` (`phase-02-auth/TD-02`); validação `class-validator` (`phase-02-auth/TD-06`); `DomainException` + filtro global como contrato de erro (`phase-02-auth/TD-07`); OpenAPI via `@nestjs/swagger` + `openapi.json` exportado (`openapi-docs-nestjs/TD-01..TD-02`). Todo endpoint novo segue esses contratos.

---

## TD-01: Tecnologia da fila de processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 (`docs/diagrams/software-arch.mermaid`) prevê um container `Message Queue` ainda marcado como `TBD`: a API publica o job e o Video Worker o consome. Os jobs são poucos (um por vídeo enviado), porém longos (ffprobe + extração de frame de arquivos de até 10GB) e precisam de retry com backoff e de um estado de falha terminal (TD-08). A stack já tem PostgreSQL 17; hoje não existe Redis nem broker.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila sobre Redis com workers Node. O NestJS tem integração oficial (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`, `@InjectQueue`). Jobs aceitam `attempts`, `backoff` exponencial, `jobId` customizado (deduplicação) e políticas de remoção.
- **Pros:** é o pacote recomendado na documentação oficial do NestJS (o Bull clássico está em manutenção). Retries, backoff, eventos de worker e jobs "stalled" são nativos. O `jobId = videoId` dá idempotência de enfileiramento de graça. Redis sobe como um container leve no Compose, alinhado ao container separado do diagrama.
- **Cons:** adiciona um serviço de infraestrutura (Redis) com requisitos de produção próprios: `maxmemory-policy noeviction`, persistência AOF e `maxRetriesPerRequest: null` nos workers. Enfileirar não participa da transação do Postgres (dual write), então é preciso enfileirar depois do commit e ter um caminho de reenfileiramento idempotente.

### Option B: pg-boss (fila sobre PostgreSQL)
- Fila implementada em tabelas do próprio Postgres com `SKIP LOCKED`. Suporta retries com backoff, dead letter e cron. Exige Node ≥ 22.12 e Postgres ≥ 13 (ambos atendidos).
- **Pros:** nenhuma infraestrutura nova. O enqueue pode ocorrer na mesma transação que muda o status do vídeo, eliminando o dual write.
- **Cons:** sem integração oficial com o NestJS (wiring manual de ciclo de vida e DI). Carga de fila no mesmo banco transacional. Contradiz o container `Message Queue` separado do diagrama de arquitetura e a expectativa da fase de ter a fila como serviço próprio no Compose. Mantenedor único.

### Option C: RabbitMQ (`amqplib` / `@nestjs/microservices` transport RMQ)
- Broker AMQP dedicado, com filas duráveis, acks manuais e dead-letter exchanges.
- **Pros:** broker maduro e agnóstico de linguagem (um worker futuro em outra stack consumiria igual). Garantias de entrega fortes com ack manual.
- **Cons:** retry com backoff não é nativo (exige DLX + TTL ou plugin de delayed messages). O transport RMQ do NestJS é orientado a mensagens, não a jobs: não tem estado de job, progresso nem tentativas. É o container mais pesado das opções, e a infraestrutura fica sobredimensionada para um único tipo de job.

**Recommendation:** **Option A (BullMQ + Redis)** — é o único caminho com integração oficial do NestJS 11 que entrega retries/backoff, estado por job e deduplicação por `jobId` sem código de infraestrutura próprio, e materializa o container `Message Queue` previsto no diagrama. O dual write é tratado por enqueue pós-commit com `jobId = videoId` e reenfileiramento idempotente (TD-08). Imagem sugerida: `redis:8-alpine` com `--maxmemory-policy noeviction --appendonly yes` (Valkey 8 é drop-in se a licença do Redis 8 for um problema).

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Estratégia de upload de arquivos de até 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Um arquivo de 10GB não pode atravessar a API sem ocupar banda, memória e sockets do processo que também atende login e consultas. A escolha define o handshake entre cliente e backend (quantas chamadas, quem envia os bytes, como retomar), por isso é cross-layer: o `next-frontend` implementará o lado cliente numa fase futura. Limites do S3 (fonte: AWS S3 User Guide, "multipart upload limits"): PUT único até **5 GiB**; multipart com partes de **5 MiB a 5 GiB** (a última pode ser menor) e **até 10.000 partes**.

**Options:**

### Option A: Upload proxy pela API (stream `multipart/form-data` → storage)
- O cliente envia o arquivo para um endpoint da API, que faz pipe do stream (busboy) para o storage via `@aws-sdk/lib-storage`.
- **Pros:** contrato simples para o cliente (um único POST). A API controla todos os bytes, o que permite validar durante o envio.
- **Cons:** 10GB passam pelo processo Node, e cada upload lento prende uma conexão da API por minutos ou horas. Viola o requisito "sem impacto na performance". Sem retomada: uma queda no byte 9GB recomeça do zero.

### Option B: PUT único via URL presigned
- A API cria o rascunho e devolve uma URL presigned de `PutObject`; o cliente envia o arquivo inteiro direto ao storage.
- **Pros:** os bytes não passam pela API. Contrato mínimo (uma URL).
- **Cons:** **não atende 10GB**, porque o PutObject tem limite de 5 GiB. Também não tem retomada nem paralelismo.

### Option C: Multipart upload direto ao storage com URLs presigned por parte
- A API cria o rascunho e inicia o `CreateMultipartUpload`. Ela assina URLs de `UploadPart` sob demanda (lotes de números de parte). O cliente envia cada parte direto ao storage e coleta os `ETag`s. Ao final, a API executa o `CompleteMultipartUpload` com a lista de partes, e um endpoint de abort cancela o upload.
- **Pros:** os bytes nunca passam pela API. Suporta 10GB com folga (10 GiB / 64 MiB = 160 partes, bem abaixo de 10.000). Permite retomada, reenviando só as partes que falharam, e paralelismo no cliente. É um protocolo nativo do S3 (idêntico em MinIO e em S3 de produção).
- **Cons:** handshake de 3+ chamadas que o cliente precisa orquestrar. O storage precisa de CORS com `ETag` em `ExposeHeaders`, senão o browser não lê o ETag de cada parte. Uploads abandonados deixam partes órfãs (mitigação: endpoint de abort + regra de lifecycle `AbortIncompleteMultipartUpload`).

### Option D: Protocolo tus (servidor tus com store S3)
- O cliente usa `tus-js-client` e o servidor tus (`@tus/server` + `@tus/s3-store`) grava em S3 com retomada nativa.
- **Pros:** retomada robusta e padronizada, com clientes prontos.
- **Cons:** os bytes continuam passando pelo servidor tus, que é o processo Node ou um serviço extra, então o problema de carga da Option A volta. É um protocolo e um serviço adicionais para manter sem ganho sobre o multipart nativo.

**Recommendation:** **Option C (multipart presigned direto ao storage)** — é a única opção que atende simultaneamente 10GB (acima do teto de 5 GiB do PUT único) e "sem impacto na performance" (a API só troca metadados). Políticas sugeridas para o contrato, todas configuráveis por env e validadas pelo Joi:
- **Tamanho máximo:** `10 GiB = 10737418240` bytes, declarado no início e conferido via `HeadObject` após o `CompleteMultipartUpload`.
- **Tamanho de parte:** fixo de `64 MiB`, calculado e devolvido pela API.
- **Expiração das URLs de parte:** 1h, com o endpoint de assinatura sob demanda permitindo renovar e retomar.
- **MIME:** o cliente declara `video/*`; a validação real do conteúdo é feita pelo ffprobe no worker (TD-07/TD-08).
- **CORS:** o storage expõe `ETag`.

Depende de TD-03 e TD-04.

**Decision:** C (Multipart presigned direto ao storage)

---

## TD-03: Biblioteca cliente de object storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** A API (multipart, presign, head, abort) e o worker (leitura do original, gravação da thumbnail) precisam de um cliente S3. O storage de produção é S3; localmente, um servidor S3-compatível (TD-05). O cliente precisa funcionar com os dois apenas trocando endpoint e credenciais.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- SDK oficial modular da AWS. Commands (`CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `GetObjectCommand`…) mais `getSignedUrl` para presign. Aponta para MinIO com `endpoint` + `forcePathStyle: true`.
- **Pros:** é o cliente do storage de produção alvo (S3), então não há troca de lib na migração. Cobertura completa da API S3, incluindo presign de `UploadPart` e `ResponseContentDisposition`. Tipagem TypeScript de primeira classe e manutenção ativa pela AWS.
- **Cons:** API verbosa (um Command por operação). A árvore de dependências é maior que a do SDK do MinIO.

### Option B: MinIO JavaScript SDK (`minio`)
- SDK do MinIO, compatível com S3, com API de alto nível (`putObject`, `presignedGetObject`…).
- **Pros:** API concisa, e alguns fluxos (upload de stream) são mais simples.
- **Cons:** o presign de `UploadPart` individual para multipart iniciado no servidor não é uma API de primeira classe, e o fluxo de multipart presigned do TD-02 depende exatamente disso. O MinIO open source está em modo de manutenção desde dez/2025, o que coloca em dúvida a manutenção do SDK. Seria uma lib de nicho para falar com S3 de produção.

**Recommendation:** **Option A (AWS SDK v3)** — o TD-02 exige presign de `UploadPart` e `CompleteMultipartUpload` orquestrados pelo servidor, que são APIs nativas do SDK v3, e o alvo de produção é S3, então a mesma lib serve local e produção trocando só `endpoint`/`forcePathStyle`. A instabilidade do ecossistema MinIO (TD-05) reforça não acoplar o código a um SDK do fornecedor.

**Decision:** A (AWS SDK v3)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Organização do storage e assinatura de URLs (endpoint interno vs público)

**Scope:** Cross-layer

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Dois pontos formam um contrato entre `compose.yaml`, schema Joi, `.env.example`, os dados persistidos (chaves no banco) e o cliente:
- **Layout de buckets/chaves:** como originais e thumbnails são endereçados.
- **Host das URLs presigned:** a assinatura SigV4 inclui o header `host` (`X-Amz-SignedHeaders=host`), então uma URL assinada para `http://minio:9000` só é válida nesse host. O browser não resolve `minio` (nome de serviço do Compose), e dentro dos containers `localhost` não é o MinIO. A regra do `CLAUDE.md` exige nome de serviço para conexões entre containers.

**Options:**

### Option A: Bucket privado único com prefixos por vídeo + dois endpoints (interno e público)
- Um bucket privado (ex.: `streamtube-videos`) com chaves determinísticas `videos/{videoId}/original` e `videos/{videoId}/thumbnail.jpg`, persistidas no banco.
- `S3_ENDPOINT=http://minio:9000` é usado para as operações server-side (API e worker). `S3_PUBLIC_ENDPOINT` é usado exclusivamente para assinar URLs entregues ao cliente: um segundo `S3Client` configurado só para presign.
- **Pros:** respeita a regra de Docker networking, porque toda conexão entre containers usa o nome de serviço. As URLs entregues funcionam no browser. As chaves por `videoId` são idempotentes (reprocessar sobrescreve a mesma thumbnail) e agrupam os artefatos para deleção futura. Um bucket só simplifica CORS e lifecycle.
- **Cons:** dois clientes S3 configurados. O endpoint público de dev (`http://localhost:9000`) é um valor voltado ao browser e precisa ser documentado como exceção consciente, pois não é uma conexão entre containers. Nos testes em container, a URL pública não é alcançável diretamente (tratado no TD-12).

### Option B: Buckets separados (vídeos privado, thumbnails público) + endpoint único
- Um bucket `videos` privado e um `thumbnails` com política public-read (URL estável sem assinatura), usando um endpoint só.
- **Pros:** a thumbnail tem URL estável e cacheável, sem presign.
- **Cons:** um endpoint único não resolve o problema do host (ou ele quebra no browser, ou quebra entre containers). Dois buckets duplicam CORS, lifecycle e setup. Thumbnail pública de vídeo em rascunho vaza conteúdo antes da publicação (Fase 04).

### Option C: Proxy de todo acesso pela API (sem URLs presigned para o cliente)
- O cliente nunca fala com o storage: a API faz stream de tudo (upload, stream, download, thumbnail).
- **Pros:** um endpoint só e nenhum problema de host ou CORS.
- **Cons:** contradiz o TD-02 (os bytes do upload passariam pela API) e a relação `Frontend → Object Storage: Streams` do diagrama. Reintroduz a carga que a fase proíbe.

**Recommendation:** **Option A (bucket privado único + endpoints interno/público)** — é a única opção compatível ao mesmo tempo com o TD-02 (upload direto), com a regra de nome de serviço do `CLAUDE.md` e com a restrição de host assinado do SigV4. Chaves canônicas de env a fixar no schema Joi, `.env.example` e `compose.yaml`: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`. A criação do bucket e a configuração de CORS ficam a cargo do plano (bootstrap idempotente). Depende de TD-03 e TD-05.

**Decision:** A (Bucket privado único + endpoints interno/público)

---

## TD-05: Imagem do storage S3-compatível no Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O projeto aponta MinIO como storage local, com a mesma API do S3. Porém, a MinIO Inc. parou de publicar as imagens da edição comunitária em out/2025, colocou o repositório em modo de manutenção em dez/2025, e as imagens `minio/minio`/`minio/mc` foram removidas do Docker Hub. Verificado em 2026-09-22 com `docker manifest inspect`: `minio/minio` e `bitnami/minio` estão **indisponíveis**; `quay.io/minio/minio`, `cgr.dev/chainguard/minio`, `rustfs/rustfs`, `chrislusf/seaweedfs` e `dxflrs/garage` estão disponíveis. A escolha fixa a imagem, o comando e as variáveis de ambiente do serviço no `compose.yaml`.

**Options:**

### Option A: MinIO via Chainguard (`cgr.dev/chainguard/minio`)
- MinIO compilado a partir do fonte pela Chainguard (base Wolfi), com patches de CVE. Roda com `server /data` e `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- **Pros:** mantém o MinIO previsto no projeto e no enunciado, com patches de segurança. Mesma API S3 e mesmas variáveis do MinIO clássico.
- **Cons:** o tier gratuito oferece essencialmente a tag `latest`, então só dá para fixar a versão por digest. Imagem minimalista, sem shell/curl e sem o cliente `mc`: o healthcheck e a criação do bucket precisam ser feitos por fora (via SDK no bootstrap).

### Option B: MinIO legado congelado (`quay.io/minio/minio:RELEASE.<data>`)
- Última release comunitária publicada, fixada por tag.
- **Pros:** tag de release fixável. A imagem inclui shell e dá para usar `mc` de uma imagem irmã.
- **Cons:** congelada e sem patches, incluindo a vulnerabilidade divulgada em out/2025, quando a publicação parou. Pode desaparecer do Quay como aconteceu no Docker Hub.

### Option C: SeaweedFS com gateway S3 (`chrislusf/seaweedfs`)
- Storage distribuído Apache-2.0 com endpoint S3-compatível (`weed server -s3`).
- **Pros:** projeto ativo, licença permissiva e tags versionadas. Suporta multipart e presign.
- **Cons:** não é MinIO (desvia do que o projeto e o enunciado nomeiam). A compatibilidade S3 é mais estreita (CORS e alguns headers diferem), e a configuração tem mais peças (master, volume, filer, s3).

### Option D: RustFS (`rustfs/rustfs`)
- Servidor S3-compatível em Rust, posicionado como substituto do MinIO.
- **Pros:** API e experiência parecidas com as do MinIO, com licença Apache-2.0.
- **Cons:** projeto jovem, com maturidade de compatibilidade S3 ainda em consolidação. Não é MinIO.

**Recommendation:** **Option A (Chainguard MinIO)** — é o único caminho que mantém o MinIO nomeado pelo projeto e continua recebendo correções de segurança. A limitação de tag se resolve fixando por digest (registrado no `library-refs.md`), e a falta de `mc` se resolve com bootstrap do bucket e CORS via SDK (TD-03/TD-04), o que ainda deixa o setup portável para S3 de produção. Se a política do tier gratuito da Chainguard mudar, a Option C é o fallback por ter versionamento estável.

**Decision:** A (Chainguard MinIO, fixado por digest)

---

## TD-06: Topologia e runtime do worker de vídeo

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O diagrama prevê um container `Video Worker (FFmpeg)` separado da API. O worker lê o banco (entidade de vídeo), o storage e a fila, exatamente as mesmas dependências e configs que a API já tem. A escolha define a estrutura do repositório, os serviços do Compose e o Dockerfile.

**Options:**

### Option A: Mesmo codebase `nestjs-project`, entrypoint dedicado e container próprio
- Um segundo bootstrap (ex.: `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP) registra só o processor da fila. O serviço `video-worker` no Compose usa a mesma imagem (`Dockerfile.dev` + ffmpeg) com outro comando.
- **Pros:** reusa entidades, repositórios, config namespaces, validação Joi e o cliente de storage, sem duplicar código. É um container separado, como no diagrama, que escala e cai independente da API. O deploy continua sendo uma imagem com dois comandos.
- **Cons:** a imagem da API também carrega o ffmpeg (+~100MB). É preciso disciplina de módulos para o `WorkerModule` não importar controllers HTTP.

### Option B: Subprojeto separado (`video-worker/`) com package próprio
- Um novo subprojeto Node (BullMQ puro ou Nest) com `package.json`, `tsconfig` e Dockerfile próprios.
- **Pros:** isolamento total de dependências e deploy, e a imagem da API fica sem ffmpeg.
- **Cons:** duplica ou extrai entidade, config e cliente S3 (exigiria um pacote compartilhado ou workspace, que é tooling de monorepo inexistente hoje). Muda o layout do repositório (novo subprojeto no `CLAUDE.md`, lint, testes e Definition of Done por subprojeto).

### Option C: Processor dentro do processo da API
- O `@Processor` fica registrado no próprio `AppModule` e o job roda no processo HTTP.
- **Pros:** zero infraestrutura nova de processo, com um container só.
- **Cons:** o processamento de vídeo compete com as requisições da API. Contradiz o container separado do diagrama. Uma falha ou OOM no processamento derruba a API.

**Recommendation:** **Option A (mesmo codebase, entrypoint e container próprios)** — entrega o isolamento de processo que o diagrama e o requisito "sem travar o sistema" pedem, sem pagar o custo de duplicar entidades e configs nem de introduzir tooling de monorepo. O custo (ffmpeg na imagem da API) é aceitável em dev e habilita os testes de integração do worker no mesmo container de testes (TD-12). Depende de TD-01 e TD-07.

**Decision:** A (Mesmo codebase, entrypoint e container próprios)

---

## TD-07: Invocação do FFmpeg/ffprobe e leitura do arquivo original

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O worker precisa extrair duração e metadados (ffprobe) e gerar uma thumbnail a partir de um frame (ffmpeg) de um original de até 10GB guardado no storage. Há duas escolhas acopladas: como chamar o FFmpeg a partir do Node e como o FFmpeg lê o original (baixar tudo para disco ou ler por HTTP com range).

**Options:**

### Option A: Binários do sistema (pacote Debian `ffmpeg`) via `child_process.execFile`/`spawn`, lendo o original por URL presigned interna
- O ffmpeg vem do apt no Dockerfile (a base `node:*-slim` é Debian). O worker chama `ffprobe -v error -print_format json -show_format -show_streams <url>` e `ffmpeg -ss <t> -i <url> -frames:v 1 ...` com uma URL presigned de GET assinada para o endpoint **interno**. O FFmpeg faz seek via HTTP Range, sem baixar 10GB.
- **Pros:** sem dependência npm e sem wrapper para manter. O JSON do ffprobe é estável e fácil de tipar. O seek por range lê só os bytes necessários (header + região do frame), então não exige 10GB de disco temporário no worker. O processo filho não bloqueia o event loop, o que evita jobs "stalled" no BullMQ.
- **Cons:** o parsing de argumentos e de erros é código próprio (pequeno). Arquivos com o `moov` atom no fim (MP4 não "faststart") exigem uma leitura adicional no fim do arquivo, o que o range suporta, mas com mais latência.

### Option B: `fluent-ffmpeg`
- Wrapper fluente clássico sobre os binários do ffmpeg.
- **Pros:** API conveniente (`.screenshots()`, `.ffprobe()`).
- **Cons:** **repositório arquivado em 22/05/2025**, com aviso explícito de que "não funciona mais corretamente com versões recentes do ffmpeg". Adotar uma lib abandonada numa fase nova é dívida certa.

### Option C: Binários via npm (`ffmpeg-static`/`ffprobe-static`) + `spawn`, baixando o original para disco temporário
- Binários estáticos instalados pelo npm. O worker baixa o original para `/tmp` e processa localmente.
- **Pros:** a versão do ffmpeg fica fixada pelo `package.json`, independente da imagem base. Processar localmente evita qualquer peculiaridade de I/O por HTTP.
- **Cons:** o download no postinstall é frágil em builds offline e nos bind mounts do Windows. Baixar o original exige disco igual ao tamanho do vídeo (até 10GB) por job concorrente e dobra o tráfego com o storage.

**Recommendation:** **Option A (ffmpeg do sistema via `execFile`, com leitura por URL presigned interna)** — remove a dependência abandonada (B) e o custo de 10GB de disco por job (C), e o ffprobe/ffmpeg com input HTTP já faz seek por range. Políticas sugeridas: frame da thumbnail em ~10% da duração (0s se a duração for desconhecida ou curta), escala para largura máxima de 1280px, saída JPEG. Metadados persistidos: duração, largura, altura, codecs de vídeo/áudio, bitrate e formato do container (subconjunto do JSON do ffprobe em coluna `jsonb`). Depende de TD-04 (endpoint interno) e TD-06.

**Decision:** A (ffmpeg do sistema via `execFile` + URL presigned interna)

---

## TD-08: Ciclo de status do vídeo, falhas e consistência fila ↔ banco

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O `project-plan.md` usa "rascunho" em duas fases com sentidos que se sobrepõem:
- Fase 03: "pré-cadastro automático do vídeo como rascunho ao iniciar o upload".
- Fase 04: "fluxo de rascunho → publicação".

Ou seja, um vídeo permanece rascunho **depois** de processado, até ser publicado. Ao mesmo tempo, o processamento tem estados próprios (enviando, processando, pronto, erro). A modelagem precisa refletir isso no banco, definir o que acontece em falhas e garantir que o job é enfileirado exatamente quando o upload é concluído (dual write banco + Redis, TD-01).

**Options:**

### Option A: Enum único `status` (`draft → processing → ready | failed`)
- Uma coluna com o ciclo inteiro. `draft` = pré-cadastrado, upload em andamento.
- **Pros:** modelo mínimo, que espelha literalmente a sequência rascunho → processando → pronto/erro.
- **Cons:** "rascunho" passa a significar "upload não concluído", o que colide com o "rascunho → publicação" da Fase 04 (um vídeo `ready` ainda é rascunho editorial). A Fase 04 teria que adicionar `published` ao mesmo enum, misturando estado técnico e editorial, ou redefinir `draft`, o que seria uma migration de semântica.

### Option B: Duas dimensões ortogonais — `status` editorial + `processing_status` técnico
- `status` (editorial): `draft` na Fase 03, e a Fase 04 acrescenta `published` e a visibilidade.
- `processing_status` (técnico): `uploading → processing → ready | failed`, com `processing_error` preenchido em `failed`.
- O pré-cadastro cria `status=draft, processing_status=uploading`.
- **Pros:** cada coluna tem uma única responsabilidade. A Fase 04 evolui só a dimensão editorial, sem tocar no pipeline técnico. O banco mostra, sem ambiguidade, rascunho em processamento, rascunho pronto e rascunho com erro.
- **Cons:** uma coluna a mais. Consultas de "o que dá para assistir" precisam considerar `processing_status = ready`.

**Recommendation:** **Option B (duas dimensões)** — é a leitura fiel do `project-plan.md` ("rascunho" é um estado editorial que atravessa as fases 03 e 04), e evita que a Fase 04 precise redefinir um enum já persistido. O ciclo exigido pela fase fica visível no banco como `draft` + `uploading → processing → ready | failed`.

Política de falha e consistência sugerida:
- **Conclusão do upload:** em transação, `CompleteMultipartUpload` → `HeadObject` (confere o tamanho) → `processing_status=processing`; commit.
- **Enqueue:** após o commit, com `jobId = videoId` (dedup). Se o enqueue falhar, o endpoint de conclusão é idempotente e reenfileira quando o vídeo já está `processing`.
- **Retries no job:** `attempts: 3` com backoff exponencial.
- **Esgotou as tentativas ou arquivo inválido:** `failed` + `processing_error`. Um arquivo que o ffprobe rejeita (não é vídeo) vai direto para `failed`, sem retry, como erro não recuperável.
- **Processamento idempotente:** chaves determinísticas (TD-04), e reprocessar sobrescreve os metadados e a thumbnail.

Depende de TD-01 e TD-02.

**Decision:** B (`status` editorial + `processing_status` técnico)

---

## TD-09: Identificador da URL única do vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público estável para compor a URL (API hoje; rota do frontend depois), sem colisão entre vídeos. Como o título só é editável na Fase 04 e não existe no início do upload, identificadores derivados de título não servem. O identificador aparece em rotas da API, no banco (constraint) e nas rotas futuras do frontend, por isso é cross-layer.

**Options:**

### Option A: UUID da chave primária na URL
- A URL usa o `id` uuid da tabela (`/videos/3f2c…`).
- **Pros:** zero código, e unicidade garantida pela PK.
- **Cons:** 36 caracteres, URL longa e pouco amigável para compartilhar. Acopla o identificador público à chave interna (trocar a PK ou expor outra tabela vira breaking change).

### Option B: ID curto aleatório (11 chars base64url de 64 bits via `crypto.randomBytes`) com `UNIQUE` + retry
- Coluna `public_id` com 8 bytes aleatórios (`node:crypto`) codificados em base64url (11 caracteres, estilo YouTube), constraint `UNIQUE` e retry em violação `23505`, no mesmo padrão já usado para o nickname em `ChannelsService`.
- **Pros:** URL curta e compartilhável. Com 2^64 possibilidades, o custo de enumeração é desprezível, e a constraint garante ausência de conflito mesmo no caso improvável de colisão. Nenhuma dependência nova. Desacopla o ID público da PK.
- **Cons:** uma coluna e um índice únicos a mais, e um laço de retry (padrão já existente no projeto).

### Option C: Biblioteca `nanoid`
- ID curto gerado pela `nanoid` (alfabeto URL-safe).
- **Pros:** API pronta e alfabeto/tamanho configuráveis.
- **Cons:** a `nanoid` v5 é ESM-only, o que atrita com a compilação CommonJS do projeto e com o `ts-jest`. Para quem só precisa de bytes aleatórios em base64url, o `node:crypto` nativo entrega o mesmo sem dependência.

**Recommendation:** **Option B (ID curto de 64 bits via `node:crypto` + `UNIQUE` + retry)** — dá URLs curtas e sem conflito por construção (constraint no banco), reutiliza o padrão de retry em unique violation já estabelecido em `ChannelsService` (`phase-02-auth/TD-10`) e não adiciona dependência. A PK continua uuid, e o `public_id` é o identificador de todas as rotas públicas de vídeo.

**Decision:** B (ID curto 64 bits via `node:crypto` + UNIQUE + retry)

---

## TD-10: Entrega do vídeo — streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** A reprodução não pode exigir o download completo: o player precisa pedir faixas de bytes (`Range`) e receber `206 Partial Content` para buscar e avançar. O download precisa entregar o arquivo com `Content-Disposition: attachment`. O diagrama indica `Frontend → Object Storage: Streams`, ou seja, os bytes de vídeo vêm do storage, não da API.

**Options:**

### Option A: Proxy pela API com suporte a Range
- A API recebe `Range`, repassa ao `GetObject` com `Range` e faz pipe do stream com `206`, `Content-Range` e `Accept-Ranges`. O download é o mesmo endpoint, com `attachment`.
- **Pros:** a API controla cada requisição de bytes (autorização por request, métricas). Uma URL estável, sem expiração.
- **Cons:** todo o tráfego de vídeo passa pela API, a mesma carga que o TD-02 evitou no upload. Contradiz `Frontend → Object Storage: Streams` do diagrama. Exige implementar à mão o parsing de `Range`, os casos `416` e o backpressure.

### Option B: Redirect da API (`302`) para URL presigned de GET no storage
- Os endpoints de stream e download validam o vídeo (existe e está `ready`) e respondem `302` para uma URL presigned de curta duração no endpoint público (TD-04). O download assina com `ResponseContentDisposition=attachment; filename=...`. O storage atende `Range` → `206` nativamente.
- **Pros:** os bytes de vídeo não passam pela API (alinhado ao diagrama e ao "sem travar"). `Range`/`206`, seek e cache ficam a cargo do storage, que é o componente certo, com implementação S3 madura. O `<video>` e o download seguem redirects nativamente. O mesmo mecanismo serve stream e download.
- **Cons:** a URL final expira (o player pode precisar pedir o redirect de novo numa sessão muito longa). A autorização é por emissão de URL, não por request de bytes. Depende do endpoint público correto (TD-04).

### Option C: Streaming adaptativo (HLS/DASH)
- O worker transcodifica para segmentos (`.m3u8`/`.ts` ou fMP4) em múltiplas resoluções, e o player consome os segmentos.
- **Pros:** bitrate adaptativo e melhor experiência em redes ruins, que é o padrão de plataformas grandes.
- **Cons:** transcodificação completa é ordens de magnitude mais cara que extrair metadados e um frame. Multiplica o armazenamento, e a fase não pede adaptatividade. É extrapolação do escopo, que pede apenas "sem necessidade de download completo".

**Recommendation:** **Option B (302 para presigned GET)** — atende "sem download completo" via `Range`/`206` nativo do storage, mantém os bytes fora da API (coerente com o TD-02 e com o diagrama) e resolve streaming e download com o mesmo mecanismo, só variando o `ResponseContentDisposition`. HLS fica como evolução futura, fora do escopo desta fase. Expiração sugerida das URLs de entrega: 1h, configurável. Depende de TD-03 e TD-04.

**Decision:** B (302 para presigned GET; Range/206 nativo do storage)

---

## TD-11: Acesso a streaming e download nesta fase

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** O `project-plan.md` diz que "qualquer pessoa pode assistir vídeos sem cadastro". Por outro lado, visibilidade (público/unlisted) e "rascunho → publicação" são bullets da **Fase 04**, e nesta fase todo vídeo é `draft` (TD-08). É preciso decidir quem pode emitir as URLs de stream e download agora, sem implementar capacidades da Fase 04. Isso afeta o guard dos endpoints e o que o frontend poderá fazer.

**Options:**

### Option A: Público (`@Public()`) para vídeos `ready`, acessados pelo ID não adivinhável
- Stream e download não exigem autenticação. Basta o vídeo existir e estar `processing_status=ready`. O `public_id` de 64 bits (TD-09) funciona como no modelo "unlisted": só quem tem o link acessa. Upload, conclusão e abort continuam restritos ao dono do canal (JWT).
- **Pros:** atende o princípio de acesso anônimo do projeto. Compatível com `<video src>` e links diretos (o browser não envia `Authorization` em tags de mídia). Não antecipa lógica de visibilidade da Fase 04.
- **Cons:** até a Fase 04, um rascunho pronto é assistível por quem tiver o link. A Fase 04 precisará adicionar a restrição de visibilidade nesses endpoints.

### Option B: Apenas o dono do canal (JWT) até a Fase 04
- Stream e download exigem autenticação e posse do canal.
- **Pros:** nenhum rascunho acessível a terceiros.
- **Cons:** o `<video>` e links de download não carregam o header `Authorization`, o que exigiria proxy pelo BFF ou tokens na query (outra decisão). Contradiz o acesso anônimo do projeto. É uma política de visibilidade antecipada da Fase 04.

**Recommendation:** **Option A (público para vídeos `ready`, por ID não adivinhável)** — segue o princípio de acesso anônimo do `project-plan.md`, funciona com o player nativo sem mudar o transporte de token herdado da Fase 02, e mantém a fase dentro do seu escopo. A regra de visibilidade editorial é uma capacidade da Fase 04 e deve ser registrada como restrição herdada para ela. Depende de TD-08, TD-09 e TD-10.

**Decision:** A (Público para vídeos `ready` via ID não adivinhável)

---

## TD-12: Estratégia de testes para storage, fila e worker

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O projeto testa contra infraestrutura real do Compose: integração com Postgres e Mailpit reais (`testing-guide-nestjs-project`). A Fase 03 adiciona storage, fila e worker. Três questões cruzam `compose.yaml`, `.env`, Jest e o worker:
- **Como exercitar o worker nos testes:** processo do Compose ou no processo do Jest.
- **Como isolar os dados de teste:** bucket e fila compartilhados com o dev.
- **Como alcançar URLs presigned de dentro do container:** o host público não resolve lá (TD-04).

**Options:**

### Option A: Infra real do Compose com worker instanciado no processo do teste
- Testes de integração e e2e usam MinIO e Redis reais do Compose. O e2e sobe o `WorkerModule` no mesmo processo Jest (via `Test.createTestingModule`), em vez de depender do container `video-worker`.
- Isolamento por bucket e prefixo de fila próprios dos testes, via env.
- O vídeo de fixture é gerado no setup com `ffmpeg -f lavfi` (arquivo pequeno e determinístico, sem binário versionado).
- Para URLs presigned, o helper de teste conecta ao endpoint interno enviando o header `Host` do endpoint público, o que mantém a assinatura válida.
- **Pros:** exercita S3, fila e FFmpeg reais, sem mocks. É hermético (o código testado é o do checkout, não o do container em execução). É determinístico (o teste espera o evento de conclusão do job).
- **Cons:** o container de testes (`nestjs-api`) precisa do ffmpeg, o que o TD-06 já prevê. O helper de `Host` é um detalhe de teste a documentar.

### Option B: Infra real + dependência do container `video-worker` em execução
- O e2e só enfileira e faz polling no banco até o `video-worker` do Compose concluir.
- **Pros:** exercita a topologia de produção (dois processos).
- **Cons:** não é hermético (o container pode rodar código desatualizado ou estar parado). Tem timing não determinístico e compartilha a fila com o dev.

### Option C: Mocks de S3/fila (ex.: `aws-sdk-client-mock`) + FFmpeg real
- O storage e a fila são simulados, e só o FFmpeg é real.
- **Pros:** testes rápidos e sem infraestrutura adicional.
- **Cons:** contradiz a política do projeto de testar contra infraestrutura real. Não detecta problemas de assinatura, CORS, multipart nem de conexão com o Redis, que são exatamente os riscos da fase.

**Recommendation:** **Option A (infra real + worker no processo do teste)** — cumpre a política de não mockar o que dá para testar com a infra do Compose, mantendo a hermeticidade e o determinismo que a Option B perde. A topologia de dois processos é verificada manualmente/por healthcheck do serviço `video-worker` no Compose, sem colocar a suíte automatizada na dependência dele. Depende de TD-04, TD-06 e TD-07.

**Decision:** A (Infra real + worker no processo do teste)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila de processamento | A (BullMQ + Redis via `@nestjs/bullmq`) | **A** |
| TD-02 | Cross-layer | Estratégia de upload de até 10GB | C (Multipart presigned direto ao storage) | **C** |
| TD-03 | Backend | Biblioteca cliente de object storage | A (AWS SDK v3) | **A** |
| TD-04 | Cross-layer | Organização do storage e assinatura de URLs | A (Bucket privado único + endpoints interno/público) | **A** |
| TD-05 | Repo-wide | Imagem do storage S3-compatível no Compose | A (Chainguard MinIO, fixado por digest) | **A** |
| TD-06 | Repo-wide | Topologia e runtime do worker | A (Mesmo codebase, entrypoint e container próprios) | **A** |
| TD-07 | Backend | Invocação do FFmpeg e leitura do original | A (ffmpeg do sistema via `execFile` + URL presigned interna) | **A** |
| TD-08 | Backend | Ciclo de status, falhas e consistência fila ↔ banco | B (`status` editorial + `processing_status` técnico) | **B** |
| TD-09 | Cross-layer | Identificador da URL única | B (ID curto 64 bits via `node:crypto` + UNIQUE + retry) | **B** |
| TD-10 | Cross-layer | Entrega: streaming e download | B (302 para presigned GET; Range/206 nativo do storage) | **B** |
| TD-11 | Cross-layer | Acesso a stream/download nesta fase | A (Público para vídeos `ready` via ID não adivinhável) | **A** |
| TD-12 | Backend | Estratégia de testes para storage, fila e worker | A (Infra real + worker no processo do teste) | **A** |
