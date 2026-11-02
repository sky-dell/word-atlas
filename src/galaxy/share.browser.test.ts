import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';

test('galaxy poster keeps statistics clear of the divider and new two-line brand footer',async()=>{
 const server=await createServer({configFile:false,publicDir:false,appType:'custom',server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},logLevel:'error'});
 server.middlewares.use((req,res,next)=>{if(req.url==='/__brand-test__'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body></body></html>');}else next();});
 let browser;
 try {
  await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string');
  browser=await chromium.launch({args:['--no-sandbox']});const page=await browser.newPage({acceptDownloads:true});
  await page.goto(`http://127.0.0.1:${address.port}/__brand-test__`);
  const download=page.waitForEvent('download').catch(()=>null);
  const geometry=await page.evaluate(async()=>{
   const text:Array<{value:string;top:number;bottom:number}>=[],rules:number[]=[];
   const fill=CanvasRenderingContext2D.prototype.fillText,rect=CanvasRenderingContext2D.prototype.fillRect;
   CanvasRenderingContext2D.prototype.fillText=function(value,x,y,maxWidth){
    const size=this.measureText(value);text.push({value,top:y-size.actualBoundingBoxAscent,bottom:y+size.actualBoundingBoxDescent});
    if(maxWidth===undefined)fill.call(this,value,x,y);else fill.call(this,value,x,y,maxWidth);
   };
   CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(h===1&&y>1000)rules.push(y);rect.call(this,x,y,w,h);};
   try{
    const source=document.createElement('canvas');source.width=600;source.height=600;
    source.getContext('2d')!.fillRect(0,0,600,600);
    const modulePath='/src/galaxy/share.ts';
    const {shareGalaxy}=await import(modulePath);
    await shareGalaxy(source,1248,7298);return {text,rules};
   }finally{CanvasRenderingContext2D.prototype.fillText=fill;CanvasRenderingContext2D.prototype.fillRect=rect;}
  });
  const file=await download;assert.ok(file,'Poster should download');assert.equal(file.suggestedFilename(),'words-and-beyond-galaxy.png');
  const stats=geometry.text.find(t=>t.value.startsWith('共 '));assert.ok(stats);
  const brand=geometry.text.find(t=>t.value==='词与远方 · Words & Beyond');assert.ok(brand);
  const tagline=geometry.text.find(t=>t.value==='多懂一个词，多看一点世界。');assert.ok(tagline);
  assert.equal(geometry.rules.length,1);
  assert.ok(stats.bottom+12<geometry.rules[0],`Statistics bottom ${stats.bottom} must be above divider ${geometry.rules[0]}`);
  assert.ok(brand.top>geometry.rules[0]+12);
  assert.ok(tagline.top>brand.bottom+4);
 }finally{await browser?.close();await server.close();}
});
