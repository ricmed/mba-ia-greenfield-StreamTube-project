import * as http from 'http';
import * as https from 'https';

/**
 * Fetches a presigned URL from inside the Docker network.
 *
 * URLs handed to clients are signed against `S3_PUBLIC_ENDPOINT` (a
 * browser-reachable host), which does not resolve from inside a container.
 * SigV4 signs the `Host` header, so the request is sent to the in-cluster
 * endpoint while still presenting the public host — the signature stays valid
 * and no test-only bypass of the real signing path is needed
 * (phase-03-videos/TD-04, phase-03-videos/TD-12).
 */
export async function fetchSignedUrl(
  signedUrl: string,
  init: {
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  headers: Map<string, string>;
  text: () => Promise<string>;
  buffer: () => Promise<Buffer>;
}> {
  const target = new URL(signedUrl);
  const internal = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');
  const publicEndpoint = new URL(
    process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  );

  const signedHost = target.host;
  const reachesPublicEndpoint = target.host === publicEndpoint.host;

  if (reachesPublicEndpoint) {
    target.protocol = internal.protocol;
    target.hostname = internal.hostname;
    target.port = internal.port;
  }

  const client = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          // Keep the signed host; only the TCP destination changed.
          host: signedHost,
          ...(init.body ? { 'content-length': init.body.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers = new Map<string, string>(
            Object.entries(response.headers).map(([key, value]) => [
              key.toLowerCase(),
              Array.isArray(value) ? value.join(', ') : (value ?? ''),
            ]),
          );

          resolve({
            status: response.statusCode ?? 0,
            headers,
            text: () => Promise.resolve(body.toString('utf8')),
            buffer: () => Promise.resolve(body),
          });
        });
      },
    );

    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}
