import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from './http-handler.mjs';

async function fixture(fn, options={}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-http-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>atlas</h1>');
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'a.mp3'), '0123456789');
  const acmeRoot = path.join(root, 'acme');
  await fs.mkdir(path.join(acmeRoot, '.well-known/acme-challenge'), { recursive: true });
  await fs.writeFile(path.join(acmeRoot, '.well-known/acme-challenge', 'proof'), 'challenge');
  let called = 0;
  const server = http.createServer(createApplication({root, acmeRoot, secureOrigin: 'https://atlas.test', accounts: {async handle(req,res) {called++;res.writeHead(200);res.end('private');return true;}}, ...options}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, () => called, root); }
  finally { await new Promise(r => server.close(r)); await fs.rm(root,{recursive:true,force:true}); }
}

test('domain-only rejects IP/unknown hosts before static and API routes; domain HTTP redirects, ACME remains available', async()=>fixture(async(base,called)=>{
  for(const route of ['/','/health','/api/auth/session','/assets/a.mp3']) {
    const response=await fetch(base+route,{redirect:'manual'});
    assert.equal(response.status,403,route);
    assert.equal(response.headers.get('set-cookie'),null);
  }
  const request=(route,headers)=>new Promise((resolve,reject)=>{http.get(base+route,{headers},res=>{res.resume();res.on('end',()=>resolve(res));}).on('error',reject);});
  const redirect=await request('/words/?test=1',{host:'atlas.test'});
  assert.equal(redirect.statusCode,308);
  assert.equal(redirect.headers.location,'https://atlas.test/words/?test=1');
  assert.equal((await fetch(base+'/',{headers:{host:'evil.test','x-forwarded-host':'atlas.test','x-forwarded-proto':'https'},redirect:'manual'})).status,403);
  assert.equal(await(await fetch(base+'/.well-known/acme-challenge/proof')).text(),'challenge');
  assert.equal(called(),0);
},{domainOnly:true}));

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

test('MP4 delivery has browser video MIME, seek ranges and HEAD metadata', async () => fixture(async(base,called,root) => {
  await fs.writeFile(path.join(root,'assets','video.mp4'),'0123456789');
  const partial=await fetch(base+'/assets/video.mp4',{headers:{Range:'bytes=3-6'}});
  assert.equal(partial.headers.get('content-type'),'video/mp4');
  assert.equal(partial.status,206);
  assert.equal(partial.headers.get('content-range'),'bytes 3-6/10');
  assert.equal(await partial.text(),'3456');
  const head=await fetch(base+'/assets/video.mp4',{method:'HEAD'});
  assert.equal(head.headers.get('content-length'),'10');
  assert.equal(await head.text(),'');
}));
