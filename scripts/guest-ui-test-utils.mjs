export async function openGuestMenu(page){
  const trigger=page.getByRole('button',{name:/^游客账户菜单/});
  if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
}
export async function leaveGuest(page){
  await openGuestMenu(page);
  await page.getByRole('button',{name:'退出游客模式',exact:true}).click();
}
