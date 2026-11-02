import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validPassword,hashPassword,verifyPassword} from './passwords.mjs';

test('new passwords accept eight characters only when all four character classes are present',async()=>{
  assert.equal(validPassword('Abcdef1!'),true);
  for(const password of ['Abcde1!','abcdef1!','ABCDEF1!','Abcdefg!','Abcdef12','Aa12345 ','Aa12345中','Aa1!'+ 'x'.repeat(125),'correct horse battery staple',null,12345678]){
    assert.equal(validPassword(password),false,`must reject ${JSON.stringify(password)}`);
    await assert.rejects(hashPassword(password),error=>error.code==='invalid_password');
  }
  const hash=await hashPassword('Abcdef1!');assert.equal(await verifyPassword('Abcdef1!',hash),true);
  assert.equal(await verifyPassword('Abcdef2!',hash),false);
  assert.equal(validPassword('Aa1!'+'x'.repeat(124)),true);
  assert.equal(validPassword('Aa12345😀'),true);
  assert.equal(validPassword('Aa1'+'😀'.repeat(125)),true);
  assert.equal(validPassword('Aa1'+'😀'.repeat(126)),false);
});

test('password verification accepts legacy hashes without applying the new creation policy',async()=>{
  const password='correct horse battery staple',salt='0123456789abcdef0123456789abcdef';
  const key=scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:48*1024*1024});
  const hash=`scrypt$1$32768$8$1$${salt}$${key.toString('hex')}`;
  assert.equal(await verifyPassword(password,hash),true);
  assert.equal(await verifyPassword('incorrect old password',hash),false);
});

test('public packaging includes the shared password policy without allowing private shared files',()=>{
  execFileSync('python3',['-c',`
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('package_public', 'scripts/package_public.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.allowed(Path('shared/password-policy.mjs'))
assert module.allowed(Path('shared/password-policy.d.mts'))
assert not module.allowed(Path('shared/.env'))
assert not module.allowed(Path('shared/private.key'))
`],{cwd:new URL('..',import.meta.url),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
});
