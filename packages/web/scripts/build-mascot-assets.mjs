import sharp from 'sharp';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const ids = ['base','builder','analyst','guardian','dispatcher','reviewer','automator','planner','scout'];
const parts = ['body','left','right','leg-left','leg-right','happy','blink','concerned','excited'];
for (const id of ids) {
 const source=resolve(root,`packages/web/artwork/mascots/${id}/parts.png`);
 if (!existsSync(source)) throw Error(`Missing source: ${source}`);
 const {width,height}=await sharp(source).metadata();
 const out=resolve(root,`packages/web/src/assets/mascots/${id}`); mkdirSync(out,{recursive:true});
 for(let i=0;i<parts.length;i++) {
  const left=Math.round(i%3*width/3), top=Math.round(Math.floor(i/3)*height/3);
  const w=Math.round((i%3+1)*width/3)-left, h=Math.round((Math.floor(i/3)+1)*height/3)-top;
  let part=sharp(source).extract({left,top,width:i===0?Math.round(width*0.36):w,height:i===0?Math.round(height*0.38):h});
  if(i===0) part=sharp(await part.png().toBuffer()).trim({threshold:16});
  await part.resize(384,384,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp({quality:92,alphaQuality:100}).toFile(resolve(out,`${parts[i]}.webp`));
 }
 const layers=await Promise.all([['leg-left',105,290,120],['leg-right',185,290,120],['body',40,20,320],['left',id==='scout'?50:0,id==='scout'?190:155,id==='scout'?120:200],['right',270,175,120],['happy',120,65,160]].map(async([part,left,top,size])=>({input:await sharp(resolve(out,`${part}.webp`)).resize(size,size).toBuffer(),left,top})));
 const full=await sharp({create:{width:400,height:400,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers).png().toBuffer();
 await sharp(full).webp({quality:94}).toFile(resolve(out,'standing.webp'));
 await sharp(full).extract({left:55,top:22,width:290,height:290}).resize(256,256).webp({quality:94}).toFile(resolve(out,'portrait.webp'));
 // Avatars draw at 28-64 CSS px: srcset picks these instead of the 256 px portrait.
 for (const size of [96,192]) await sharp(full).extract({left:55,top:22,width:290,height:290}).resize(size,size).webp({quality:90}).toFile(resolve(out,`portrait-${size}.webp`));
 console.log(`${id}: rig parts, portrait, standing pose`);
}
const shared=resolve(root,'packages/web/src/assets/mascots/shared');mkdirSync(shared,{recursive:true});
await sharp(resolve(root,'packages/web/artwork/mascots/shared/laptop.png')).resize(512,512).webp({quality:92}).toFile(resolve(shared,'laptop.webp'));
const supplements=resolve(root,'packages/web/artwork/mascots/shared/supplements.png');
const sm=await sharp(supplements).metadata();
for(const [i,name] of ['typing-left','typing-right','focused'].entries()) {
 const left=Math.round(i*sm.width/3), width=Math.round((i+1)*sm.width/3)-left;
 const cell=await sharp(supplements).extract({left,top:0,width,height:sm.height}).png().toBuffer();
 await sharp(cell).trim({threshold:16}).resize(name==='focused'?280:320,name==='focused'?240:160,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp({quality:94}).toFile(resolve(shared,`${name}.webp`));
}
