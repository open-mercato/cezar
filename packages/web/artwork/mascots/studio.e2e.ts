import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('nine complete characters, real motion, states and pause', { video: 'on', trace: 'on' }, async ({ app, screen, browser }) => {
 await browser.setViewport({width:1440,height:1100});
 await app.open('/mascots.html');
 await expect(screen.getByRole('heading', 'Meet your managers.')).toBeVisible();
 for (const name of ['Cezar','Builder','Analyst','Guardian','Dispatcher','Reviewer','Automator','Planner','Scout']) {
  await screen.getByRole('region','Characters').getByRole('button',name).tap();
  await expect(screen.getByRole('heading',name,{exact:true})).toBeVisible();
  await expect(browser.locator('[data-slot="manager-mascot"] canvas')).toBeVisible();
  const changes = await browser.evaluate(async () => {
   const canvas = document.querySelector('canvas')!;
   const before=canvas.toDataURL();
   for(let i=0;i<35;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   return canvas.toDataURL() !== before;
  });
  expect(changes).toBe(true);
  await app.screenshot(name.toLowerCase());
 }
 await screen.getByRole('region','Characters').getByRole('button','Cezar').tap();
 for(const state of ['thinking','working','waiting','present','success','alert','walk','error','idle']) {
  await screen.getByRole('button',state,{exact:true}).tap();
  await expect(browser.locator('[data-slot="manager-mascot"] canvas')).toBeVisible();
  await browser.evaluate(async()=>{ for(let i=0;i<35;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())); return true; });
  await app.screenshot(state);
 }
 await screen.getByRole('button','Dark canvas').tap();
 await app.screenshot('lineup-dark');
 await screen.getByRole('button','Pause motion').tap();
 await expect(screen.getByRole('button','Resume motion')).toBeVisible();
 const still = await browser.evaluate(async () => {
  const canvas=document.querySelector('canvas')!;
  await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const before=canvas.toDataURL();
  for(let i=0;i<20;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  return before===canvas.toDataURL();
 });
 expect(still).toBe(true);
 await browser.setViewport({width:390,height:844});
 await app.screenshot('mobile');
 expect(await browser.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('reduced-motion preference renders a stable status pose', async ({app,browser,screen})=>{
 await browser.addInitScript(()=>{
  const original=window.matchMedia.bind(window);
  window.matchMedia=(query)=>{const result=original(query); if(query.includes('prefers-reduced-motion')) Object.defineProperty(result,'matches',{value:true}); return result;};
 });
 await app.open('/mascots.html');
 await screen.getByRole('button','working',{exact:true}).tap();
 await expect(browser.locator('[data-slot="manager-mascot"] canvas')).toBeVisible();
 const stable=await browser.evaluate(async()=>{
  const canvas=document.querySelector('canvas')!;
  for(let i=0;i<3;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const first=canvas.toDataURL();
  for(let i=0;i<20;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  return first===canvas.toDataURL();
 });
 expect(stable).toBe(true);
 await app.screenshot('reduced-motion-working');
});
