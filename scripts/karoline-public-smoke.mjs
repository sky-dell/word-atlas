// Public read-only media checks; guest writes are intercepted, never persisted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const origin=process.env.TEST_URL||'https://west.cloud-ip.cc';
const output='.local/karoline/public';
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const results=[],errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/guest/**',route=>{
    const session={guest:{id:'public-readonly-fixture',name:'游客_视频核验',createdAt:Date.now(),expiresAt:Date.now()+86400000,hardExpiresAt:Date.now()+604800000},csrfToken:'fixture'};
    return route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/state')?{...session,version:0,state:{records:{'word-atlas:settings':JSON.stringify({onboarded:true,splash:false,sfx:false})}}}:session});
  });
  await page.goto(origin+'/#/read?tab=karoline');
  await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();
  await page.locator('main.main').waitFor();
  const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});
  if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).click();
  await page.getByRole('button',{name:'卡罗琳特辑（Karoline）',exact:true}).click();
  await page.locator('.karoline-card').first().waitFor();
  assert.equal(await page.locator('.karoline-card').count(),21);
  assert.equal(await page.getByRole('button',{name:'播放 第 16 课',exact:true}).count(),1);
  for(const path of await page.locator('.karoline-card img').evaluateAll(images=>images.map(img=>img.getAttribute('src')))){
    const response=await page.request.get(new URL(path,origin).href);
    assert.equal(response.status(),200);assert.equal(response.headers()['content-type'],'image/jpeg');
  }
  results.push('21 posters served over HTTPS; lesson 16 appears once');
  const library=await page.request.get(origin+'/atlas/extras/karoline/index.json').then(r=>r.json());
  assert.equal(library.videos.length,21);
  assert.equal(library.videos.filter(v=>v.title==='第 16 课').length,1);
  for(const {id} of library.videos){
    const response=await page.request.get(origin+'/atlas/extras/karoline/'+id+'.mp4',{headers:{Range:'bytes=0-31'}});
    assert.equal(response.status(),206,id);assert.equal(response.headers()['content-type'],'video/mp4');
    assert.equal((await response.body()).length,32);
  }
  results.push('21 MP4 HTTPS MIME and seek range checks passed');
  assert.equal((await page.request.get(origin+'/atlas/extras/karoline/karoline-16.mp4',{headers:{Range:'bytes=0-31'}})).status(),404);
  for(const theme of ['light','dark'])for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>{delete document.documentElement.dataset.skin;document.documentElement.dataset.theme=theme;},theme);
    await page.locator('.karoline-card img').evaluateAll(async images=>{await Promise.all(images.map(async img=>{img.loading='eager';await img.decode();}));});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`${output}/library-${theme}-${width}.png`,fullPage:true});
    results.push(`${theme} ${width}px no horizontal overflow`);
  }
  await page.getByRole('button',{name:'播放 第 16 课',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  assert.equal(await page.locator('video').evaluate(video=>video.videoHeight),480);
  await page.locator('video').evaluate(async video=>{await video.play();});
  await page.waitForFunction(()=>document.querySelector('video').currentTime>.1);
  await page.locator('video').evaluate(video=>{video.pause();video.currentTime=60;});
  await page.waitForFunction(()=>{const video=document.querySelector('video');return Math.abs(video.currentTime-60)<1&&!video.seeking;});
  await page.screenshot({path:`${output}/player-desktop.png`,fullPage:true});
  await page.getByRole('button',{name:'下一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-18'));
  await page.getByRole('button',{name:'上一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-17'));
  await page.getByRole('button',{name:'上一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-15'));
  results.push('Retained 480p lesson 16 plays/seeks; previous/next navigation remains correct');
  assert.deepEqual(errors,[]);
  console.log(results.join('\n'));
}finally{
  await browser.close();
  await fs.writeFile(output+'/results.json',JSON.stringify({results,errors},null,2)+'\n');
}
