import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
const base=process.env.ATLAS_BROWSER_TEST_URL;
test('guest starts and reloads in daylight without losing its temporary identity or study records',{skip:!base,timeout:90000},async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({colorScheme:'dark'});
  try{
    await page.goto(base!);
    await page.getByRole('button',{name:'以游客身份登录',exact:true}).click();
    await page.locator('.account-guest-trigger').waitFor();
    const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).click();
    assert.equal(await page.locator('main .guest-notice').count(),0);
    assert.equal(await page.getByRole('button',{name:'返回入口',exact:true}).count(),0);
    assert.doesNotMatch(await page.locator('body').innerText(),/不会创建正式账户|闲置24小时|最长保留7天/);
    for(const width of [320,375,390,768,1440]){
      await page.setViewportSize({width,height:844});
      const trigger=page.getByRole('button',{name:/^游客账户菜单/});assert.match(await trigger.innerText(),/游客_.*游客模式/s);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}px guest header fits`);
    }
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    await page.getByRole('button',{name:'切换到深色',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    await page.locator('.guest-notice [role=status]').filter({hasText:'已暂存'}).waitFor({state:'attached'});
    const snapshot=()=>page.evaluate(async()=>{
      const session=await(await fetch('/api/guest/session')).json();
      const response=await fetch('/api/guest/state?dataset=all',{headers:{'X-Guest-ID':session.guest.id,'X-Guest-CSRF':session.csrfToken}});
      if(!response.ok)throw Error('Cannot read own guest state');
      return {session,state:await response.json()};
    });
    const before=await snapshot();
    await page.reload();
    await page.locator('.account-guest-trigger').waitFor();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    const after=await snapshot();
    assert.equal(after.session.guest.id,before.session.guest.id);
    const withoutTheme=(records:Record<string,string>)=>Object.fromEntries(Object.entries(records).filter(([key])=>key!=='word-atlas:appearance'));
    assert.deepEqual(withoutTheme(after.state.state.records),withoutTheme(before.state.state.records));
  }finally{await browser.close();}
});
test('mobile specialist practice titles remain legible on one line', {skip:!base,timeout:60000}, async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try{
    await page.goto(base+'/#/practice');await page.getByRole('button',{name:'以游客身份登录',exact:true}).tap();await page.locator('.practice').waitFor();
    const welcome=page.getByRole('dialog',{name:'欢迎',exact:true});if(await welcome.isVisible())await welcome.getByRole('button',{name:'出发',exact:true}).tap();
    for(const width of [320,375,390,430]){
      await page.setViewportSize({width,height:844});
      const headings=page.locator('.specialist-links .mode-card b');assert.equal(await headings.count(),2);
      for(const heading of await headings.all()){
        const lines=await heading.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size;});
        assert.equal(lines,1,`${width}px: ${await heading.innerText()} must not leave an orphan character on a second line`);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    for(const width of [768,844,900]){
      await page.setViewportSize({width,height:390});
      for(const text of await page.locator('.topbar-logo .logo-text b,.topnav a').all()){
        const lines=await text.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size;});
        assert.equal(lines,1,`${width}px: header text wraps: ${await text.innerText()}`);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
  }finally{await browser.close();}
});
