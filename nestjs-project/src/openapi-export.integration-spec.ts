import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('exports every schema with its properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;

    // The export runs under ts-node, where the swagger CLI plugin does not
    // transform the DTOs. A schema that comes out as an empty object means its
    // class lost (or never had) explicit @ApiProperty decorators, and the
    // frontend would generate a client with no request body at all.
    const empty = Object.entries(schemas)
      .filter(
        ([, schema]) =>
          Object.keys((schema.properties ?? {}) as Record<string, unknown>)
            .length === 0,
      )
      .map(([name]) => name);

    expect(empty).toEqual([]);
  });

  it('carries the class-validator constraints of each documented DTO', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    const props = schemas['RegisterDto'].properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.email).toMatchObject({ type: 'string', format: 'email' });
    expect(props.password).toMatchObject({ minLength: 8, maxLength: 128 });
    expect(schemas['RegisterDto'].required).toEqual(['email', 'password']);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos endpoints', () => {
    const API_ERROR_REF = '#/components/schemas/ApiErrorEnvelope';

    /** Every endpoint of the phase, with the status codes of the Error Catalog. */
    const ENDPOINTS: [string, string, string[]][] = [
      ['/videos', 'post', ['201', '400', '401', '404', '413', '415']],
      [
        '/videos/{publicId}/upload/parts',
        'post',
        ['200', '400', '401', '403', '404', '409'],
      ],
      [
        '/videos/{publicId}/upload/complete',
        'post',
        ['200', '400', '401', '403', '404', '409', '422'],
      ],
      [
        '/videos/{publicId}/upload',
        'delete',
        ['204', '401', '403', '404', '409'],
      ],
      ['/videos/{publicId}', 'get', ['200', '404']],
      ['/videos/{publicId}/stream', 'get', ['302', '404', '409']],
      ['/videos/{publicId}/download', 'get', ['302', '404', '409']],
    ];

    function operationOf(
      path: string,
      method: string,
    ): Record<string, unknown> {
      const paths = document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      return operation;
    }

    it.each(ENDPOINTS)(
      'documents %s (%s) with a summary under the videos tag',
      (path, method) => {
        const operation = operationOf(path, method);

        expect(operation.tags).toContain('videos');
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      },
    );

    it.each(ENDPOINTS)(
      'declares every response of %s (%s) from the Error Catalog',
      (path, method, statuses) => {
        const responses = operationOf(path, method).responses as Record<
          string,
          unknown
        >;

        expect(Object.keys(responses).sort()).toEqual(statuses);
      },
    );

    it.each(ENDPOINTS)(
      'uses the shared error envelope on every 4xx of %s (%s)',
      (path, method, statuses) => {
        const responses = operationOf(path, method).responses as Record<
          string,
          Record<string, unknown>
        >;

        for (const status of statuses.filter((s) => s.startsWith('4'))) {
          const content = responses[status].content as Record<
            string,
            Record<string, unknown>
          >;
          const schema = content['application/json'].schema as Record<
            string,
            unknown
          >;
          expect(schema['$ref']).toBe(API_ERROR_REF);
        }
      },
    );

    it('requires the access token on the upload endpoints only', () => {
      for (const [path, method] of ENDPOINTS) {
        const security = operationOf(path, method).security as
          | Array<Record<string, unknown>>
          | undefined;
        // The three read/delivery routes are the GETs; everything else is an
        // upload operation restricted to the owner.
        if (method === 'get') {
          // Advertising auth on a public media route would be a lie the
          // frontend acts on.
          expect(security).toBeUndefined();
        } else {
          expect(security?.some((req) => 'access-token' in req)).toBe(true);
        }
      }
    });

    it.each(['/videos/{publicId}/stream', '/videos/{publicId}/download'])(
      'describes the redirect headers of %s',
      (path) => {
        const responses = operationOf(path, 'get').responses as Record<
          string,
          Record<string, unknown>
        >;
        const headers = responses['302'].headers as Record<string, unknown>;

        expect(headers).toHaveProperty('Location');
        expect(headers).toHaveProperty('Cache-Control');
      },
    );

    it.each([
      'CreateVideoDto',
      'SignUploadPartsDto',
      'CompleteUploadDto',
      'UploadedPartDto',
      'VideoResponseDto',
      'VideoMetadataDto',
    ])('exports %s with its properties', (name) => {
      const components = document.components as Record<string, unknown>;
      const schemas = components.schemas as Record<
        string,
        Record<string, unknown>
      >;

      expect(schemas[name]).toBeDefined();
      // The export runs under ts-node, where the swagger CLI plugin does not
      // transform the DTOs — only explicit @ApiProperty keeps the exported
      // contract from degrading to an empty object.
      expect(
        Object.keys(schemas[name].properties as Record<string, unknown>).length,
      ).toBeGreaterThan(0);
    });
  });
});
