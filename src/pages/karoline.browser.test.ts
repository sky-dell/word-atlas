import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base=process.env.ATLAS_BROWSER_TEST_URL;
test('Karoline library has 21 unique lessons and every local video plays and seeks', {skip:!base,timeout:240_000}, async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(`${base}/#/read`);
    await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();
    await page.locator('main.main').waitFor();
    const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});
    if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).click();
    await page.getByRole('button',{name:'卡罗琳特辑（Karoline）',exact:true}).click({timeout:5000});
    await page.locator('.karoline-card').first().waitFor();
    assert.equal(await page.locator('.karoline-card').count(),21);
    assert.equal(await page.getByRole('button',{name:'播放 第 16 课',exact:true}).count(),1);
    assert.deepEqual(await page.locator('.karoline-card').evaluateAll(cards=>cards.map(c=>c.getAttribute('data-order'))),Array.from({length:21},(_,i)=>String(i+1)));
    await page.locator('.karoline-card img').evaluateAll(async images=>{await Promise.all(images.map(image=>new Promise<void>((resolve,reject)=>{const img=image as HTMLImageElement;img.loading='eager';if(img.complete){img.naturalWidth?resolve():reject(Error('Broken poster'));return;}img.onload=()=>resolve();img.onerror=()=>reject(Error('Broken poster'));})));});
    await page.locator('.karoline-card').first().click();
    await page.locator('.karoline-player video').waitFor();
    await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=1;});
    assert.match(await page.locator('video').getAttribute('src')??'',/karoline-01\.mp4$/);
    await page.locator('video').evaluate(async node=>{await (node as HTMLVideoElement).play();});
    await page.waitForFunction(()=>document.querySelector('video')!.currentTime>.2);
    await page.locator('video').evaluate(node=>{const v=node as HTMLVideoElement;v.pause();v.currentTime=30;});
    await page.waitForFunction(()=>Math.abs(document.querySelector('video')!.currentTime-30)<1&&!document.querySelector('video')!.seeking);
    await page.getByLabel('视频播放速度').selectOption('1.25');
    assert.equal(await page.locator('video').evaluate(node=>(node as HTMLVideoElement).playbackRate),1.25);
    await page.getByRole('button',{name:'下一集',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('video')?.getAttribute('src')?.endsWith('karoline-02.mp4'));
    await page.reload();await page.locator('video').waitFor();
    assert.match(page.url(),/id=karoline-02/);
    // Decode actual H.264 derivatives, not a simulated media API.
    const library=await page.request.get(base+'/atlas/extras/karoline/index.json').then(r=>r.json());
    for(const {id}of library.videos){
      await page.goto(`${base}/#/read?tab=karoline&id=${id}`);
      await page.waitForFunction(expected=>{const v=document.querySelector('video');return v?.getAttribute('src')?.endsWith(expected+'.mp4')&&v.readyState>=2;},id);
      await page.locator('video').evaluate(async node=>{await (node as HTMLVideoElement).play();});
      await page.waitForFunction(()=>document.querySelector('video')!.currentTime>.1);
      await page.locator('video').evaluate(node=>{const v=node as HTMLVideoElement;v.pause();v.currentTime=30;});
      await page.waitForFunction(()=>{const v=document.querySelector('video')!;return Math.abs(v.currentTime-30)<1&&!v.seeking;});
      assert.equal(await page.locator('video').evaluate(node=>(node as HTMLVideoElement).error),null,`${id} decodes`);
    }
    await page.goto(`${base}/#/read?tab=karoline&id=karoline-16`);
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video&&video.readyState>=1;});
    assert.match(await page.locator('video').getAttribute('src')??'',/karoline-17\.mp4$/);
    assert.equal(await page.locator('video').evaluate(node=>(node as HTMLVideoElement).videoHeight),480);
    await page.getByRole('button',{name:'下一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-18'));
    await page.getByRole('button',{name:'上一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-17'));
    await page.getByRole('button',{name:'上一集',exact:true}).click();await page.waitForFunction(()=>location.hash.includes('id=karoline-15'));
    await fs.mkdir('.local/karoline/screenshots',{recursive:true});
    await page.screenshot({path:'.local/karoline/screenshots/player-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'全部视频',exact:true}).click();
    await page.locator('.karoline-card').nth(3).click();
    await page.getByRole('status').filter({hasText:'原文件缺少音轨'}).waitFor();
    await page.goto(`${base}/#/read?tab=karoline&id=not-found`);
    await page.getByText('没有找到这段视频。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'全部视频',exact:true}).click();
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:850});
      await page.screenshot({path:`.local/karoline/screenshots/library-${width}.png`,fullPage:true});
      const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,12));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}px: ${JSON.stringify(overflow)}`);
    }
    await page.getByRole('button',{name:'原版书',exact:true}).click();
    await page.locator('.wa-book').first().waitFor();
    await page.getByRole('button',{name:'词与远方短文',exact:true}).click();
    await page.locator('.wa-short-card').first().waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
