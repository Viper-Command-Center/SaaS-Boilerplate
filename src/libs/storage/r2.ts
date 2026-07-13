/**
 * Cloudflare R2 storage — S3-compatible, signed with AWS SigV4 by hand.
 *
 * No SDK on purpose: @aws-sdk/client-s3 is ~20MB of dependencies for four HTTP
 * calls. node:crypto gives us everything we need, and the build stays clean.
 *
 * Railway variables (same bucket as BudgetSmart — nothing new to create):
 *   R2_ENDPOINT           https://<account>.r2.cloudflarestorage.com
 *   R2_BUCKET_NAME        the bucket
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY  (R2_TOKEN_VALUE accepted as a fallback alias)
 *   R2_PUBLIC_URL         optional public/custom domain for direct links
 *
 * Every object is keyed `tenants/<tenantId>/…` so one workspace can never read
 * another's files: the key is always derived server-side from the session's
 * tenant, never from client input.
 */

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';

export type R2Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
};

export function r2Config(): R2Config | null {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_TOKEN_VALUE;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    bucket,
    accessKeyId,
    secretAccessKey,
    publicUrl: process.env.R2_PUBLIC_URL?.replace(/\/$/, '') || undefined,
  };
}

export function storageConfigured(): boolean {
  return r2Config() !== null;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** Sign and send one S3 request. */
async function signedFetch(
  cfg: R2Config,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  key: string,
  body?: Buffer,
  contentType?: string,
): Promise<Response> {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodeKey(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260713T101500Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');

  const headers: Record<string, string> = {
    'host': url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) {
    headers['content-type'] = contentType;
  }

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaders.map(h => `${h}:${headers[h]}`).join('\n')}\n`;
  const signedHeaderList = signedHeaders.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    '', // no query
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return fetch(url.toString(), {
    method,
    headers: { ...headers, Authorization: authorization },
    body: body as BodyInit | undefined,
  });
}

/** Upload bytes. Returns the object key. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const cfg = r2Config();
  if (!cfg) {
    throw new Error('Storage is not configured (R2_* variables missing).');
  }
  const resp = await signedFetch(cfg, 'PUT', key, body, contentType || 'application/octet-stream');
  if (!resp.ok) {
    throw new Error(`R2 upload failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
  return key;
}

/** Download bytes (used to stream a file back to the browser or the agent). */
export async function getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
  const cfg = r2Config();
  if (!cfg) {
    throw new Error('Storage is not configured.');
  }
  const resp = await signedFetch(cfg, 'GET', key);
  if (!resp.ok) {
    throw new Error(`R2 download failed: HTTP ${resp.status}`);
  }
  return {
    body: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function deleteObject(key: string): Promise<void> {
  const cfg = r2Config();
  if (!cfg) {
    return;
  }
  await signedFetch(cfg, 'DELETE', key).catch(() => {});
}

/**
 * Public URL when the bucket has a public/custom domain. Otherwise callers use
 * `/api/files/<id>/content`, which streams through the app with an auth check.
 */
export function publicUrlFor(key: string): string | null {
  const cfg = r2Config();
  if (!cfg?.publicUrl) {
    return null;
  }
  return `${cfg.publicUrl}/${encodeKey(key)}`;
}

/** Pull a remote URL (e.g. Kie.ai output) straight into R2. */
export async function archiveRemote(
  url: string,
  key: string,
): Promise<{ key: string; bytes: number; contentType: string }> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
  const body = Buffer.from(await resp.arrayBuffer());
  await putObject(key, body, contentType);
  return { key, bytes: body.length, contentType };
}
