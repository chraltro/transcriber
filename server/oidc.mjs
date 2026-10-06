// Uploads from the GitHub workflow prove where they come from with GitHub's OIDC token: signed
// by GitHub for one run of one workflow, valid for minutes, no secret to keep anywhere.
import { createPublicKey, verify } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
let keys = { at: 0, byKid: new Map() };

async function keyFor(kid) {
  if (!keys.byKid.has(kid) || Date.now() - keys.at > 3600e3) {
    const res = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(15000) });
    const { keys: list } = await res.json();
    keys = { at: Date.now(), byKid: new Map(list.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return keys.byKid.get(kid);
}

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// -> the token's claims if it is GitHub's, for `audience`, from `workflow` (e.g.
// "chraltro/transcriber/.github/workflows/shows.yml") on the main branch; else throws.
export async function verifyGithubToken(token, { audience, workflow, now = Date.now() / 1000, getKey = keyFor }) {
  const [h, p, sig] = String(token).split('.');
  if (!sig) throw new Error('not a JWT');
  const header = part(h);
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`);
  const key = await getKey(header.kid);
  if (!key) throw new Error('unknown key');
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) throw new Error('bad signature');
  const c = part(p);
  if (c.iss !== ISSUER) throw new Error('wrong issuer');
  if (c.aud !== audience) throw new Error('wrong audience');
  if (!(c.exp > now) || (c.nbf && c.nbf > now + 60)) throw new Error('expired');
  if (c.ref !== 'refs/heads/main') throw new Error('not from main');
  if (!String(c.job_workflow_ref || c.workflow_ref || '').startsWith(`${workflow}@`)) throw new Error('wrong workflow');
  return c;
}
