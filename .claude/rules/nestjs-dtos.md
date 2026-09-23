---
paths:
  - 'nestjs-project/**/*.dto.ts'
description: 'DTO conventions for input validation and data transfer'
---

# DTO Rules

## Validation

- Always use `class-validator` decorators on every field (`@IsString()`, `@IsEmail()`, `@IsNotEmpty()`, etc.)
- Apply `class-transformer` decorators when type coercion is needed (e.g., `@Type(() => Number)`)

## OpenAPI Documentation

DTOs are the source of request/response schemas in the exported `openapi.json`. Field-level documentation is the DTO's responsibility — controllers document operations (status codes, summaries), not schemas.

### Every field needs an explicit `@ApiProperty`

This holds for request DTOs as much as for response DTOs. Do not rely on the `@nestjs/swagger` CLI plugin configured in `nestjs-project/nest-cli.json`.

The plugin is real, and in `nest build` / `nest start` it does infer `@ApiProperty` from the `class-validator` decorators. But it only works as a **TypeScript AST transformer**, and the exported contract is not produced that way:

- `npm run openapi:export` runs under `ts-node`, with no transformer.
- The Jest suites run under `ts-jest`, likewise.

In both paths an unannotated DTO is exported as `{"properties": {}}` — and `openapi.json` is the artifact the Next.js frontend consumes, so a client generated from it would have no request body at all. This was a real defect: every auth DTO shipped empty until it was fixed.

Generating the metadata ahead of time with `PluginMetadataGenerator` does **not** rescue the ts-node path in this project. The generated file emits relative dynamic imports, and `moduleResolution: nodenext` rejects them without a `.js` extension while ts-node fails to resolve them with one — both forms raise `ERR_MODULE_NOT_FOUND`. See the comment in `nestjs-project/src/metadata.ts`.

Mirror the validator in the annotation, and keep the two in sync when either changes:

```typescript
export class RegisterDto {
  @ApiProperty({
    description: 'Address the confirmation link is sent to',
    format: 'email',
    example: 'someone@example.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
```

The duplication between `@MinLength(8)` and `minLength: 8` is the cost of an accurate exported contract. The regression test `exports every schema with its properties`, in `nestjs-project/src/openapi-export.integration-spec.ts`, fails the build if any schema comes out empty — a DTO added without annotations breaks the suite instead of silently degrading the contract.

Canonical request DTO: `nestjs-project/src/auth/dto/register.dto.ts`. Canonical response DTO: `nestjs-project/src/common/openapi/api-error-envelope.dto.ts`.

### Cases that need more than the plain annotation

- **Polymorphic / union types** (e.g., `string | string[]`, `oneOf`) — use `@ApiProperty({ oneOf: [...] })`.
- **Optional / nullable fields** — declare `@ApiProperty({ required: false, nullable: true })`.
- **Interfaces used as a field type** — an interface produces no schema. Declare a DTO class that implements it, as `VideoMetadataDto` does in `nestjs-project/src/videos/dto/video-response.dto.ts`.

### Reuse the shared error envelope

The error envelope is a single DTO across the project (`ApiErrorEnvelope`), referenced from controllers via `getSchemaPath(ApiErrorEnvelope)`. Do not create per-module error DTOs — extend or reuse the envelope instead.

## Separation of Concerns

- Create separate DTOs per operation: `CreateXDto`, `UpdateXDto`, `QueryXDto`
- Never use an entity class as a DTO — entities are database models, DTOs are API contracts
- For update DTOs, use `PartialType(CreateXDto)` from `@nestjs/mapped-types` to avoid duplication

## Naming

- File naming: `create-user.dto.ts`, `update-video.dto.ts`, `query-channel.dto.ts`
- Class naming: `CreateUserDto`, `UpdateVideoDto`, `QueryChannelDto`
