/**
 * Generic AWS SigV4 request signer (node:crypto only — no aws-sdk).
 *
 * We already sign S3/R2 requests by hand in libs/storage/r2.ts; this is the same
 * algorithm generalised so any AWS service can be called with fetch, and — the
 * reason it exists — so a WebSocket upgrade request can be signed for the
 * AgentCore browser automation stream (which requires SigV4 HEADERS, not a
 * presigned query string).
 */

import { createHash, createHmac } from 'node:crypto';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

export type AwsCreds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export function awsCreds(): AwsCreds | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

export function awsRegion(): string {
  return process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
}

/**
 * Sign a request and return the headers to send.
 *
 * `url` may be https:// or wss:// — for a WebSocket the upgrade is an HTTP GET,
 * so we sign it as GET with an empty payload.
 */
export function signRequest(a: {
  method: string;
  url: string;
  service: string;
  region: string;
  body?: string;
  creds: AwsCreds;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  // wss:// and https:// share the same canonical form for signing purposes.
  const url = new URL(a.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  const body = a.body ?? '';
  const payloadHash = sha256(body);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260714T101500Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    'host': url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(a.creds.sessionToken ? { 'x-amz-security-token': a.creds.sessionToken } : {}),
    ...(a.extraHeaders ?? {}),
  };

  const signedNames = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = `${signedNames
    .map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h) as string]).trim()}`)
    .join('\n')}\n`;
  const signedHeaderList = signedNames.join(';');

  // Query params must be sorted for the canonical request.
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a1], [b1]) => (a1 < b1 ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    a.method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${a.region}/${a.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${a.creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, a.region);
  const kService = hmac(kRegion, a.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${a.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
}
