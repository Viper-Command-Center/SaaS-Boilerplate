/**
 * SSH key pairs for the WP-CLI provider (and any future SSH-backed adapter).
 *
 * RSA-3072 in PKCS#1 PEM on purpose: it is the private-key format `ssh2`
 * parses natively (its parser rejects ed25519 in PKCS#8, which is what
 * node:crypto emits), and `ssh-rsa` public keys are accepted by every hosting
 * control panel. The public key is derived THROUGH ssh2's own parser, so a key
 * we hand out is by construction one the client library can use.
 */

import { generateKeyPairSync } from 'node:crypto';
import { utils as sshUtils } from 'ssh2';

export type SshKeyPair = {
  /** PEM, `-----BEGIN RSA PRIVATE KEY-----` — seal this, never display it. */
  privateKeyPem: string;
  /** One line, `ssh-rsa AAAA… <comment>` — what the client pastes into their host. */
  publicKeyOpenSsh: string;
};

export function generateSshKeyPair(comment: string): SshKeyPair {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyOpenSsh: derivePublicKey(privateKey, comment) };
}

/** OpenSSH one-line public key for a stored private key (for "show public key"). */
export function derivePublicKey(privateKeyPem: string, comment: string): string {
  const parsed = sshUtils.parseKey(privateKeyPem);
  if (parsed instanceof Error) {
    throw new Error(`SSH key could not be parsed: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) {
    throw new Error('SSH key could not be parsed.');
  }
  const safeComment = comment.replace(/[^\w.@-]+/g, '-').slice(0, 60);
  return `${key.type} ${key.getPublicSSH().toString('base64')} ${safeComment}`;
}
