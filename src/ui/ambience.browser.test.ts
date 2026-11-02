import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';

test('environment sound popup fits small and landscape touch viewports and stays interactive',async()=>{
  const server=await createServer({configFile:false,publicDir:false,appType:'custom',server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},logLevel:'error',plugins:[{
    name:'ambience-fixture',resolveId(id){if(id==='/ambience-fixture.js')return '\0ambience-fixture';},load(id){if(id==='\0ambience-fixture')return `import React from 'react';import{createRoot}from'react-dom/client';import'/src/styles/app.css';import{AmbiencePicker}from'/src/ui/Ambience.tsx';createRoot(document.getElementById('root')).render(React.createElement('div',{style:{position:'fixed',left:'calc(100vw - 120px)',top:8}},React.createElement(AmbiencePicker)));`;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/ambience-test'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/ambience-fixture.js"></script>');}else next();});}
  }]});
  let browser;
  try{
    await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string');
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:320,height:568},isMobile:true,hasTouch:true});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${address.port}/ambience-test`);await page.getByRole('button',{name:'环境声',exact:true}).tap({timeout:5000});const popup=page.getByRole('dialog',{name:'环境声',exact:true});await popup.waitFor();
    for(const [width,height]of [[320,568],[390,844],[844,390]]){
      await page.setViewportSize({width,height});await page.waitForFunction(()=>document.querySelector('.amb-pop')?.getAnimations().every(a=>a.playState==='finished'));
      const box=await popup.boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`${width}x${height}: popup outside viewport: ${JSON.stringify(box)}`);
      await popup.getByRole('button').first().tap();assert.equal(await popup.isVisible(),true,'Selecting an option must not be treated as outside click');
      await popup.getByRole('button',{name:'安静',exact:true}).tap();assert.equal(await popup.getByRole('button',{name:'安静',exact:true}).getAttribute('aria-pressed'),'true');
    }
    await page.touchscreen.tap(2,2);await popup.waitFor({state:'hidden'});
    await page.addInitScript(()=>Object.defineProperty(globalThis,'ResizeObserver',{value:undefined,configurable:true}));
    await page.setViewportSize({width:320,height:568});await page.reload();await page.getByRole('button',{name:'环境声',exact:true}).tap();await popup.waitFor();
    const fallback=await popup.boundingBox();assert.ok(fallback&&fallback.x>=0&&fallback.x+fallback.width<=320&&fallback.y+fallback.height<=568);
    await page.touchscreen.tap(2,2);await popup.waitFor({state:'hidden'});
    const trigger=page.getByRole('button',{name:'环境声',exact:true});await trigger.focus();await page.keyboard.press('Enter');await popup.waitFor();
    assert.equal(await popup.evaluate(el=>el.contains(document.activeElement)),true,'Keyboard opening must enter the popup, not the page behind it');
    await page.keyboard.press('Tab');assert.equal(await popup.evaluate(el=>el.contains(document.activeElement)),true);
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'Escape restores the original trigger');
    await page.keyboard.press('Enter');await popup.waitFor();await page.keyboard.press('Control+k');await popup.waitFor({state:'hidden',timeout:2500});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await server.close();}
});
