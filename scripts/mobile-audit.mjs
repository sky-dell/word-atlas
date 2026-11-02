// Real touch-emulated mobile flow. Live mode uses only its own disposable guest.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const origin=process.env.TEST_URL||'https://west.cloud-ip.cc';
const output=path.resolve('.local/mobile-audit');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'});
const page=await context.newPage();const results=[],errors=[],layout=[],screens=[];let guestCreated=false;
page.on('pageerror',e=>errors.push(e.message));
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:e.message});console.log('FAIL '+name+': '+e.message);await page.screenshot({path:output+'/failure-'+results.length+'.png',animations:'disabled'}).catch(()=>{});}}
async function navigate(route,selector){await page.evaluate(route=>{location.hash='#/'+route;},route);await page.locator(selector).first().waitFor();await page.evaluate(async()=>{await document.fonts.ready;scrollTo(0,0);});}
async function capture(name,selector){if(selector)await page.locator(selector).first().scrollIntoViewIfNeeded();else await page.evaluate(()=>scrollTo(0,0));const file=name+'.png';await page.screenshot({path:output+'/'+file,animations:'disabled'});screens.push(file);}
async function inspect(label){const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,headerWrap:innerWidth>=760&&innerWidth<=1023?Array.from(document.querySelectorAll('.topbar-logo .logo-text b,.topnav a')).filter(el=>{const r=document.createRange();r.selectNodeContents(el);return new Set([...r.getClientRects()].map(x=>Math.round(x.top))).size>1;}).map(el=>el.textContent):[],overflow:Array.from(document.querySelectorAll('body *')).filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&r.width>0&&r.right>innerWidth+1;}).slice(0,12).map(el=>({tag:el.tagName,cls:typeof el.className==='string'?el.className:el.tagName,right:Math.round(el.getBoundingClientRect().right)}))}));if(metrics.scroll>metrics.width+1||metrics.headerWrap.length)layout.push({label,...metrics});}
try {
 await check('01 mobile domain entry and both login methods',async()=>{
  await page.goto(origin);await page.locator('.auth-entry input[name=username]').waitFor();assert.ok((await page.locator('.auth-entry input').evaluateAll(inputs=>inputs.map(el=>parseFloat(getComputedStyle(el).fontSize)))).every(size=>size>=16));await inspect('login');await capture('01-login');
  await page.getByRole('button',{name:'验证码登录',exact:true}).tap();await page.locator('input[name=code]').waitFor();await page.getByPlaceholder('请输入邮箱',{exact:true}).fill('mobile-fixture@example.invalid');await capture('02-code-login');
  await page.getByRole('button',{name:'账户登录',exact:true}).tap();await page.locator('input[name=username]').waitFor();
 });
 await check('02 registration method switching and reduced-height input access',async()=>{
  await page.getByRole('button',{name:'注册',exact:true}).tap();await page.locator('input[name=email]').waitFor();await inspect('email-registration');await capture('03-email-register');
  await page.getByRole('button',{name:'用户名注册',exact:true}).tap();await page.locator('input[name=username]').fill('mobile_audit');await page.setViewportSize({width:390,height:460});await page.locator('input[name=username]').focus();await page.getByRole('button',{name:'下一步',exact:true}).click({trial:true});await inspect('reduced-height-input');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'登录',exact:true}).tap();
 });
 await check('03 real guest entry and five touch navigation destinations',async()=>{
  await page.getByRole('button',{name:'以游客身份登录',exact:true}).tap();guestCreated=true;await page.locator('main.main').waitFor();
  const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).tap();
  await page.locator('.guest-notice').waitFor();assert.equal(await page.locator('.tabbar a').count(),5);
  for(const [name,selector]of [['今日','.today'],['图鉴','.tile'],['书房','.wa-book'],['练习','.practice'],['我的','.me']]){await page.locator('.tabbar').getByRole('link',{name,exact:true}).tap();await page.locator(selector).first().waitFor();}
 });
 await check('04 atlas search, real word sheet, pronunciation and bookmark persistence',async()=>{
  await navigate('atlas','.tile');await page.getByPlaceholder('搜索单词或中文释义').fill('library');await page.locator('.tile').first().tap();const dialog=page.getByRole('dialog');await dialog.locator('.headword').waitFor();await inspect('word-sheet');await capture('04-word-sheet');
  await dialog.getByRole('button',{name:'收藏',exact:true}).tap();await dialog.getByRole('button',{name:'取消收藏',exact:true}).waitFor();
  const sound=dialog.locator('.pron button').first();assert.ok(await sound.count());const audioResponse=page.waitForResponse(r=>r.url().includes('/audio/')&&r.url().includes('library.mp3'));await sound.tap();assert.ok([200,206].includes((await audioResponse).status()));
  await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor();await page.reload();await page.getByRole('dialog').getByRole('button',{name:'取消收藏',exact:true}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).tap();
 });
 await check('05 typing round accepts touchscreen text and completes',async()=>{
  await navigate('practice','.practice');await page.getByRole('button',{name:'收藏',exact:true}).tap();await page.getByRole('button',{name:'开始一轮',exact:true}).tap();await page.getByRole('textbox',{name:'在这里输入',exact:true}).fill('library');await page.locator('.typing-done').waitFor();await inspect('typing-result');await capture('05-typing-result');
 });
 await check('05b global search and atlas list/galaxy controls',async()=>{
  await navigate('atlas','.tile');await page.getByRole('button',{name:'搜索单词',exact:true}).tap();const palette=page.getByRole('dialog',{name:'搜索单词',exact:true});await palette.locator('input').fill('library');await palette.getByRole('option').first().tap();await page.getByRole('dialog').locator('.headword').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).tap();
  await page.getByPlaceholder('搜索单词或中文释义').fill('');await page.getByRole('button',{name:'列表视图',exact:true}).tap();await page.locator('.vlist .row').first().waitFor();await inspect('atlas-list');
  await page.getByRole('button',{name:'星图视图',exact:true}).tap();await page.locator('.galaxy-full canvas').waitFor();await page.getByRole('button',{name:'放大',exact:true}).tap();await page.getByRole('button',{name:'缩小',exact:true}).tap();await page.getByRole('button',{name:'回到全景',exact:true}).tap();await inspect('galaxy');await capture('05b-galaxy','.galaxy-full');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'分享我的星图',exact:true}).tap()]);assert.match(download.suggestedFilename(),/\.png$/);await download.saveAs(output+'/own-galaxy.png');
  await page.getByRole('button',{name:'图片视图',exact:true}).tap();await page.locator('.tile').first().waitFor();
 });
 await check('05c environment menu fits portrait/landscape and theme toggle works',async()=>{
  for(const [width,height]of [[320,568],[390,844],[844,390]]){
   await page.setViewportSize({width,height});await page.getByRole('button',{name:'环境声',exact:true}).tap();const menu=page.getByRole('dialog',{name:'环境声',exact:true});await menu.waitFor();await page.waitForFunction(()=>document.querySelector('.amb-pop')?.getAnimations().every(a=>a.playState==='finished'));
   const box=await menu.boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`${width}x${height}: environment menu clipped`);
   await menu.getByRole('button').first().tap();await menu.getByRole('button',{name:'安静',exact:true}).tap();await page.locator('.toast').first().waitFor({state:'hidden'});await page.screenshot({path:output+`/menu-fixed-${width}.png`,animations:'disabled'});await page.touchscreen.tap(2,2);await menu.waitFor({state:'hidden'});
  }
  await page.setViewportSize({width:390,height:844});const toggle=page.getByRole('button',{name:/切换到浅色|切换到深色/});const before=await toggle.getAttribute('aria-label');await toggle.tap();await page.waitForFunction(before=>document.querySelector('.topbar button[aria-label^="切换到"]')?.getAttribute('aria-label')!==before,before);
  await page.getByRole('button',{name:'环境声',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'环境声',exact:true}).waitFor();await page.keyboard.press('Control+k');const search=page.getByRole('dialog',{name:'搜索单词',exact:true});await search.waitFor();assert.equal(await page.getByRole('dialog',{name:'环境声',exact:true}).count(),0);await search.locator('input').fill('library');await search.getByRole('option').first().tap();await page.getByRole('dialog').locator('.headword').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).tap();
 });
 await check('06 short reading translations and comprehension choices',async()=>{
  await navigate('read?tab=short&id=r0001','.wa-article');await page.getByRole('button',{name:'中英对照',exact:true}).tap();await page.locator('.wa-translation').first().waitFor();
  for(let i=0;i<3;i++)await page.getByRole('group',{name:`第 ${i+1} 题`,exact:true}).locator('button').first().tap();await page.locator('.wa-result').waitFor();await inspect('short-reading-result');await capture('06-short-reading','.wa-result');
 });
 await check('07 book reading audio, speed and chapter navigation',async()=>{
  await navigate('read?book=the-little-prince&chapter=1','.wa-article');await page.getByRole('button',{name:'开始朗读',exact:true}).tap();await page.waitForFunction(()=>{const a=document.querySelector('audio');return a&&!a.paused&&a.currentTime>.1;});
  await page.getByLabel('朗读速度',{exact:true}).selectOption('1.2');await page.getByRole('button',{name:'暂停朗读',exact:true}).tap();await page.getByRole('button',{name:'下一章',exact:false}).tap();await page.waitForFunction(()=>document.querySelector('#wa-chapter')?.value==='2');await inspect('book-chapter');await capture('07-book');
 });
 await check('08 Karoline poster, real mobile video, seek, speed and loop',async()=>{
  await navigate('read?tab=karoline','.karoline-card');await page.locator('.karoline-card').nth(1).tap();await page.locator('video').waitFor();await page.waitForFunction(()=>document.querySelector('video').readyState>=2);await page.locator('video').tap();await page.locator('video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('video').currentTime>.1);
  await page.locator('video').evaluate(v=>{v.pause();v.currentTime=20;});await page.waitForFunction(()=>!document.querySelector('video').seeking&&Math.abs(document.querySelector('video').currentTime-20)<1);
  await page.getByLabel('视频播放速度').selectOption('1.25');assert.equal(await page.locator('video').evaluate(v=>v.playbackRate),1.25);await page.getByRole('button',{name:'单集循环',exact:true}).tap();assert.equal(await page.locator('video').evaluate(v=>v.loop),true);await inspect('video');await capture('08-video','.karoline-player');
 });
 await check('09 learning cards and answer feedback remain usable',async()=>{
  await navigate('learn','.learn-stage');await page.locator('.intro, .quiz').first().waitFor();
  for(let i=0;i<20&&await page.locator('.intro').isVisible();i++){const before=await page.locator('.learn-count').innerText();await page.getByRole('button',{name:/认识了/}).tap();await page.waitForFunction(before=>document.querySelector('.learn-count')?.textContent?.replace(/\s/g,'')!==before.replace(/\s/g,''),before);await page.locator('.intro, .quiz').first().waitFor();}
  await page.locator('.quiz').waitFor();await page.locator('.option').first().tap();await page.locator('.feedback').waitFor();await inspect('learning-feedback');await capture('09-learning','.feedback');
  await page.getByRole('button',{name:'暂停并返回',exact:true}).tap();await page.locator('.today').waitFor();
 });
 await check('10 specialist exercise answers and feedback',async()=>{
  await navigate('paraphrase?id=1','.wa-round');await page.locator('.wa-drill-choices .wa-choice').first().tap();await page.locator('.wa-feedback').waitFor();await inspect('paraphrase-answer');await capture('10-paraphrase','.wa-feedback');
  await navigate('confuse?id=bored-boring','.wa-round');await page.locator('.wa-drill-choices .wa-choice').first().tap();await page.locator('.wa-feedback').waitFor();await inspect('confuse-answer');await capture('11-confuse','.wa-feedback');
 });
 await check('11 personal settings, export and import backup',async()=>{
  await navigate('me','.me');await page.getByRole('button',{name:'极光',exact:true}).tap();await page.waitForFunction(()=>document.documentElement.dataset.skin==='aurora');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'导出备份',exact:true}).tap()]);const file=output+'/own-guest-backup.json';await download.saveAs(file);assert.match(download.suggestedFilename(),/\.json$/);
  const learned=await page.locator('.stat-strip dd').nth(1).innerText();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'清空记录',exact:true}).tap();assert.equal((await page.locator('.stat-strip dd').nth(1).innerText()).trim(),'0');
  await page.locator('input[type=file]').setInputFiles(file);await page.waitForFunction(expected=>document.querySelectorAll('.stat-strip dd')[1]?.textContent===expected,learned);await inspect('me-backup');await capture('12-me');
 });
 const routes=[['today','','.today'],['atlas','atlas','.tile'],['books','read','.wa-book'],['shorts','read?tab=short','.wa-short-card'],['book','read?book=the-little-prince&chapter=1','.wa-article'],['karoline','read?tab=karoline','.karoline-card'],['video','read?tab=karoline&id=karoline-02','video'],['practice','practice','.practice'],['paraphrase','paraphrase','.wa-level-status'],['confuse','confuse','.wa-confuse-card'],['me','me','.me'],['about','about','.about']];
 await check('12 page matrix across six mobile/tablet/orientation sizes and two themes',async()=>{
  for(const theme of ['light','dark'])for(const [width,height]of [[320,568],[375,667],[390,844],[430,932],[768,1024],[844,390]]){
   await page.setViewportSize({width,height});await page.evaluate(theme=>{delete document.documentElement.dataset.skin;document.documentElement.dataset.theme=theme;},theme);
   for(const [name,route,selector]of routes){await navigate(route,selector);await inspect(`${name}/${width}x${height}/${theme}`);if(width===390&&theme==='light')await capture('matrix-'+name);if(name==='atlas'&&width>=768&&theme==='light')await capture('matrix-atlas-'+width);}
  }
  assert.deepEqual(layout,[],'Horizontal layout overflow; see results.json');
 });
 assert.deepEqual(errors,[]);
}finally{
 if(guestCreated)try{const s=await context.request.get(origin+'/api/guest/session').then(r=>r.json());if(s.guest){const r=await context.request.delete(origin+'/api/guest/session',{headers:{Origin:origin,'X-Guest-ID':s.guest.id,'X-Guest-CSRF':s.csrfToken}});assert.equal(r.status(),200);}}catch(e){results.push({name:'own guest cleanup',status:'failed',error:e.message});}
 await browser.close();await fs.writeFile(output+'/results.json',JSON.stringify({origin,results,errors,layout,screens,engines:{tested:'Chromium mobile/touch emulation',notTested:['physical devices','Safari/WebKit engine','WeChat webview','real software keyboard','native media fullscreen']}},null,2)+'\n');
}
if(results.some(r=>r.status==='failed'))process.exitCode=1;
