import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyGithubToken } from '../../server/oidc.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = 1_800_000_000;
const good = {
  iss: 'https://token.actions.githubusercontent.com', aud: 'transcriber.demant.app', exp: NOW + 300, nbf: NOW - 10,
  ref: 'refs/heads/main', job_workflow_ref: 'chraltro/transcriber/.github/workflows/shows.yml@refs/heads/main',
};
function jwt(claims, key = privateKey, header = { alg: 'RS256', kid: 'k1' }) {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}
const opts = { audience: 'transcriber.demant.app', workflow: 'chraltro/transcriber/.github/workflows/shows.yml', now: NOW, getKey: async (kid) => (kid === 'k1' ? publicKey : null) };

test("GitHub's token for this workflow on main is accepted", async () => {
  assert.equal((await verifyGithubToken(jwt(good), opts)).ref, 'refs/heads/main');
});

test('anything else is refused', async () => {
  const refused = (token, why) => assert.rejects(verifyGithubToken(token, opts), why);
  await refused(jwt(good, other.privateKey), /bad signature/);
  await refused(jwt({ ...good, exp: NOW - 1 }), /expired/);
  await refused(jwt({ ...good, aud: 'elsewhere' }), /audience/);
  await refused(jwt({ ...good, ref: 'refs/heads/feature' }), /main/);
  await refused(jwt({ ...good, job_workflow_ref: 'someone/fork/.github/workflows/shows.yml@refs/heads/main' }), /workflow/);
  await refused(jwt({ ...good, job_workflow_ref: 'chraltro/transcriber/.github/workflows/shows.yml.evil@refs/heads/main' }), /workflow/);
  await refused(jwt({ ...good, iss: 'https://evil.example' }), /issuer/);
  await refused(jwt(good, privateKey, { alg: 'none', kid: 'k1' }), /algorithm/);
  await refused(jwt(good, privateKey, { alg: 'RS256', kid: 'k2' }), /unknown key/);
  await refused('garbage', /JWT/);
  await refused(undefined, /JWT/);
});
