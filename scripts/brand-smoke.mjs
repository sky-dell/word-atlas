import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin=process.env.TEST_URL||'http://127.0.0.1:15189';
const output=path.resolve(process.env.BRAND_OUTPUT||'.local/rebrand');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({args:['--no-sandbox']});
const results=[],errors=[];
try {
 for(const width of [1440,390,320]) {
  const ctx=await browser.newContext({viewport:{width,height:900}});
  await ctx.addInitScript(()=>{
   localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false,sfx:false,dailyNew:20}));
   localStorage.setItem('word-atlas:appearance',JSON.stringify({theme:'light'}));
   localStorage.setItem('word-atlas:v2:word-atlas-open',JSON.stringify({version:2,datasetId:'word-atlas-open',cards:{},bookmarks:['abandon'],days:{},typing:[],session:null,mistakes:[]}));
  });
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/');await page.locator('.auth-entry').waitFor();
  assert.match(await page.title(),/词与远方.*Words & Beyond/);
  await page.getByText('词与远方',{exact:true}).first().waitFor();
  assert.match(await page.locator('.auth-entry').innerText(),/多懂一个词，多看一点世界。/);
  const manifest=await page.evaluate(()=>fetch('manifest.webmanifest').then(r=>r.json()));
  assert.equal(manifest.name,'词与远方 · Words & Beyond');assert.equal(manifest.short_name,'词与远方');
  await page.getByRole('button',{name:'暂不登录，先体验（游客进入）',exact:true}).click();await page.locator('main.main').waitFor();
  for(const route of ['','atlas','me','read','practice','about','paraphrase','confuse','account','admin']) {
   // Full document navigation ensures we check this route, not the previous
   // page still mounted while a hash-change/lazy module is being processed.
   await page.goto(origin+'/?brand-check='+encodeURIComponent(route||'today')+'#/'+route);
   const protectedEntry=route==='account'||route==='admin';await page.locator(protectedEntry?'.auth-entry':'main.main').waitFor();
   const visible=await page.locator('body').innerText();assert.doesNotMatch(visible,/词光|word\s+(?:atlas|altas)|wordatlas|每天一点，记得更久/i,route);
   if(!protectedEntry)assert.match(await page.locator('footer.footer').innerText(),/多懂一个词，多看一点世界。/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No horizontal overflow: '+route);
   const logo=page.locator(protectedEntry?'.auth-entry .logo b':'.topbar-logo b');assert.ok((await logo.boundingBox()).height<32,'Chinese brand stays on one line');
  }
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('word-atlas:v2:word-atlas-open')));
  assert.ok(saved.bookmarks.includes('abandon'),'Legacy progress namespace must survive rebranding');
  await page.goto(origin+'/#/me');await page.locator('main.main').waitFor();
  assert.equal(await page.getByRole('button',{name:'账户菜单',exact:true}).count(),0);
  await page.getByRole('button',{name:'返回入口',exact:true}).click();
  const menu=page.locator('.auth-entry');await menu.waitFor();
  assert.doesNotMatch(await menu.innerText(),/词光|word\s+atlas/i);
  await page.screenshot({path:path.join(output,`brand-${width}.png`),animations:'disabled'});
  results.push(`${width}px: central entry, metadata, PWA, 10 routes, guest return, legacy progress and layout`);
  console.log('PASS '+results.at(-1));await ctx.close();
 }
 assert.deepEqual(errors,[]);
} finally {await browser.close();await fs.writeFile(path.join(output,'brand-results.json'),JSON.stringify({results,errors},null,2));}
