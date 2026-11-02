import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from './http-handler.mjs';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-http-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>atlas</h1>');
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'a.mp3'), '0123456789');
  const acmeRoot = path.join(root, 'acme');
  await fs.mkdir(path.join(acmeRoot, '.well-known/acme-challenge'), { recursive: true });
  await fs.writeFile(path.join(acmeRoot, '.well-known/acme-challenge', 'proof'), 'challenge');
  let called = 0;
  const server = http.createServer(createApplication({root, acmeRoot, secureOrigin: 'https://atlas.test', accounts: {async handle(req,res) {called++;res.writeHead(200);res.end('private');return true;}}}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, () => called, root); }
  finally { await new Promise(r => server.close(r)); await fs.rm(root,{recursive:true,force:true}); }
}

test('plain HTTP keeps guest learning but cannot expose password/account APIs', async () => fixture(async(base,called) => {
  assert.equal(await (await fetch(base+'/')).text(), '<h1>atlas</h1>');
  const session = await fetch(base+'/api/auth/session');
  assert.match(session.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await session.json(), {user:null,enabled:false,csrfToken:'',secureOrigin:'https://atlas.test'});
  const response = await fetch(base+'/api/auth/register', {method:'POST',body:'{}',headers:{'x-forwarded-proto':'https'}});
  assert.equal(response.status,426);assert.equal(called(),0);
}));

test('legacy words routes, ranges and independent ACME challenge remain available', async () => fixture(async(base) => {
  for(const p of ['/app.htm','/words/','/words/app.htm']) assert.equal(await(await fetch(base+p)).text(),'<h1>atlas</h1>');
  const range=await fetch(base+'/words/assets/a.mp3',{headers:{Range:'bytes=2-4'}});
  assert.equal(range.status,206);assert.equal(await range.text(),'234');
  assert.equal(await(await fetch(base+'/.well-known/acme-challenge/proof')).text(),'challenge');
  assert.equal((await fetch(base+'/health').then(r=>r.json())).service,'word-atlas');
}));

test('encoded traversal and symlink targets outside the static root are not served', async () => fixture(async(base,called,root) => {
  const secret=path.join(path.dirname(root),path.basename(root)+'-secret');
  await fs.writeFile(secret,'secret');await fs.symlink(secret,path.join(root,'leak.txt'));
  try {
    assert.equal((await fetch(base+'/words/%2e%2e%2fsecret')).status,403);
    assert.equal((await fetch(base+'/leak.txt')).status,403);
    assert.equal((await fetch(base+'/.well-known/acme-challenge/%2e%2e%2findex.html')).status,404);
  } finally {await fs.unlink(secret);}
}));
