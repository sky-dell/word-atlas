import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {chromium, type Browser} from 'playwright';
import {createServer, type ViteDevServer} from 'vite';
import {mkdir} from 'node:fs/promises';
let server:ViteDevServer,browser:Browser,origin:string;
before(async()=>{
 server=await createServer({configFile:false,publicDir:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},plugins:[{
  name:'me-fixture',resolveId(id){if(id==='/me-fixture.js')return '\0me-fixture';},load(id){if(id==='\0me-fixture')return `
import React from 'react';import{createRoot}from'react-dom/client';import'/src/styles/app.css';import'/src/styles/parity.css';import{Me}from'/src/pages/Me.tsx';import{AtlasContext}from'/src/atlas/context.tsx';import{store,flush}from'/src/store/store.ts';import{refreshAccount}from'/src/account/state.tsx';import{beginGuest}from'/src/guest/state.ts';
export async function mount(){await refreshAccount();if(new URLSearchParams(location.search).get('mode')==='guest')await beginGuest();store.useDataset('test');await flush();
const atlas={id:'test',cefr:['A1','A2','B1','B2','C1','C2'],topics:[['life','生活']],words:[],byId:new Map()};
createRoot(document.getElementById('root')).render(React.createElement(AtlasContext.Provider,{value:atlas},React.createElement(Me,{privateAvailable:false,appearanceCapabilities:{route:true,recall:true,repeatGap:true,examPlan:true}})));}`;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/me-test')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div class="app"><header class="topbar">词与远方</header><main class="main" id="root"></main></div>');}else next();});}
 }]});await server.listen();origin=server.resolvedUrls!.local[0];browser=await chromium.launch();await mkdir('.local/me-tabs',{recursive:true});
});
after(async()=>{await browser?.close();await server?.close();});
for(const mode of ['guest','account'])test(`My categories preserve settings and fit responsive layouts for ${mode}`,async()=>{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();page.setDefaultTimeout(5000);
 const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);process.stderr.write(e.stack+'\n');});
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  const guest={id:'test-guest',name:'游客_测试',createdAt:1,expiresAt:9999999999999,hardExpiresAt:9999999999999};
  return route.fulfill({json:path==='/api/auth/session'?{user:mode==='account'?{id:'test-account',username:'reader',nickname:'读者',role:'user',disabled:false,email:null,emailVerified:false}:null,enabled:true,csrfToken:'fixture'}:path.startsWith('/api/guest/')?(path.endsWith('/state')?{version:1,state:null}:{guest,csrfToken:'f'.repeat(64)}):{version:0,snapshot:null,backups:[]}});
 });
 try{
  await page.goto(origin+'me-test?mode='+mode,{timeout:30000});
  await page.evaluate(async()=>{const fixture=await import('/me-fixture.js' as string);await fixture.mount();});
  const tabs=page.getByRole('tablist',{name:'我的分类'});await tabs.waitFor();
  const overview=page.getByRole('tab',{name:'学习概览',exact:true});
  assert.equal(await overview.getAttribute('aria-selected'),'true');
  assert.equal(await tabs.getByRole('tab').evaluateAll(elements=>elements.every(el=>!!document.getElementById(el.getAttribute('aria-controls')!))),true,'Every tab must reference an existing panel');
  assert.equal(await page.getByRole('tabpanel').count(),1);
  assert.equal(await page.getByRole('button',{name:'导出备份',exact:true}).count(),0);
  const bounds=await page.locator('.me').boundingBox();assert.ok(bounds&&bounds.y+bounds.height<=900,'desktop overview fits one screen');
  await overview.focus();await page.keyboard.press('ArrowRight');
  const learning=page.getByRole('tab',{name:'学习设置',exact:true});assert.equal(await learning.getAttribute('aria-selected'),'true');assert.equal(await learning.evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'20',exact:true}).click();
  await page.getByRole('tab',{name:'外观与计划',exact:true}).click();await page.getByLabel('考试日期',{exact:true}).fill('2027-06-01');
  await learning.click();assert.match(await page.getByRole('button',{name:'20',exact:true}).getAttribute('class')||'',/is-on/);
  await page.getByRole('tab',{name:'外观与计划',exact:true}).click();assert.equal(await page.getByLabel('考试日期',{exact:true}).inputValue(),'2027-06-01');
  await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'数据管理',exact:true}).getAttribute('aria-selected'),'true');
  assert.match(await page.getByRole('tabpanel').innerText(),mode==='guest'?/游客学习资料/:/当前账户/);
  await page.getByRole('button',{name:'导出备份',exact:true}).waitFor();
  page.once('dialog',dialog=>void dialog.dismiss());await page.getByRole('button',{name:'清空记录',exact:true}).click();
  for(const [width,height] of [[1440,900],[390,844],[320,568],[844,390]]){
   await page.setViewportSize({width,height});
   for(const label of ['学习概览','学习设置','外观与计划','数据管理']){
    await page.getByRole('tab',{name:label,exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${mode} ${width} ${label}: horizontal overflow`);
    assert.equal(await page.getByRole('tabpanel').count(),1);
   }
   await overview.click();await page.screenshot({path:`.local/me-tabs/${mode}-${width}.png`});
  }
  await page.setViewportSize({width:320,height:568});await learning.click();await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
  await page.getByRole('tab',{name:'数据管理',exact:true}).evaluate((el:HTMLElement)=>el.click());
  await page.waitForFunction(()=>scrollY<100);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
