// Generate web derivatives; never rename or overwrite the supplied originals.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

const source=path.resolve(process.argv[2]||'/data/word-atlas/karolin_video');
const output=path.resolve('public/atlas/extras/karoline');
const ffmpeg=process.env.FFMPEG_BIN||'ffmpeg';
if(!execFileSync(ffmpeg,['-hide_banner','-encoders'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).includes('libx264'))throw Error('Set FFMPEG_BIN to an ffmpeg build with libx264 before preparing videos');
if(source===output)throw Error('Originals and derivatives must be separate');
await fs.mkdir(output,{recursive:true});
await fs.mkdir('.local/karoline',{recursive:true});
const probe=file=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',file],{encoding:'utf8'}));
const run=(args)=>new Promise((resolve,reject)=>{
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n',...args],{stdio:['ignore','ignore','inherit']});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('ffmpeg failed: '+code)));
});
const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const files=(await fs.readdir(source)).filter(n=>/\.mp4$/i.test(n)).sort((a,b)=>{
  const lesson=n=>Number(n.match(/^(\d+)\./)?.[1]||1);
  return lesson(a)-lesson(b)||Number(a.includes('(1)'))-Number(b.includes('(1)'))||a.localeCompare(b);
});
if(files.length!==21)throw Error('Expected exactly 21 deduplicated MP4 inputs; found '+files.length);
const stableId=name=>{const lesson=Number(name.match(/^(\d+)\./)?.[1]||1);return 'karoline-'+String(lesson>=16?lesson+1:lesson).padStart(2,'0');};
if(new Set(files.map(stableId)).size!==files.length)throw Error('Duplicate lesson numbers; keep only one source per lesson');
const videos=[],mapping=[];
for(const [i,name] of files.entries()){
  // ID 16 is retired. Keep existing links for the retained 480p lesson and
  // subsequent lessons stable; display order is independent of media identity.
  const id=stableId(name),input=path.join(source,name),info=probe(input);
  const video=info.streams.find(s=>s.codec_type==='video');
  if(!video)throw Error('Missing video: '+name);
  const audio=info.streams.find(s=>s.codec_type==='audio'),target=path.join(output,id+'.mp4'),poster=path.join(output,id+'.jpg');
  const duration=Number(info.format.duration);
  const sha256=await digest(input);
  const provenance=path.resolve('.local/karoline',id+'.source.json');
  let reusable=false;
  try{const previous=JSON.parse(await fs.readFile(provenance,'utf8'));reusable=previous.sourceSha256===sha256&&previous.videoSha256===await digest(target)&&previous.posterSha256===await digest(poster);}catch{}
  if(!reusable){
    // Preserve stale/partial derivatives outside the public tree. Original media
    // are never touched; unique staging allows safe retry after interruption.
    const staging=await fs.mkdtemp(path.resolve('.local/karoline/work-'));
    for(const old of [target,poster,path.join(output,id+'.pending.mp4')])try{await fs.rename(old,path.join(staging,'previous-'+path.basename(old)));}catch(e){if(e.code!=='ENOENT')throw e;}
    const temp=path.join(staging,id+'.mp4'),image=path.join(staging,id+'.jpg');
    const args=['-threads','1','-i',input,'-map','0:v:0','-map','0:a:0?','-map_metadata','-1'];
    if(video.codec_name==='h264')args.push('-c:v','copy');
    else args.push('-c:v','libx264','-preset','ultrafast','-crf','24','-maxrate','900k','-bufsize','1800k','-pix_fmt','yuv420p','-threads','1');
    args.push('-c:a','copy','-movflags','+faststart',temp);
    await run(args);
    const prepared=probe(temp);
    if(prepared.streams.find(s=>s.codec_type==='video')?.codec_name!=='h264'||Math.abs(Number(prepared.format.duration)-duration)>2||!!prepared.streams.find(s=>s.codec_type==='audio')!==!!audio)throw Error('Derivative verification failed: '+id);
    await run(['-threads','1','-ss',String(Math.min(12,duration/4)),'-i',temp,'-frames:v','1','-vf','scale=640:-2','-q:v','3','-threads','1',image]);
    await fs.rename(temp,target);await fs.rename(image,poster);
    await fs.writeFile(provenance,JSON.stringify({sourceSha256:sha256,videoSha256:await digest(target),posterSha256:await digest(poster)}));
  }
  const result=probe(target);
  if(result.streams.find(s=>s.codec_type==='video')?.codec_name!=='h264'||Math.abs(Number(result.format.duration)-duration)>2||!!result.streams.find(s=>s.codec_type==='audio')!==!!audio)throw Error('Derivative verification failed: '+id);
  const lesson=name.match(/^\d+\./)?.[0].replace('.','');
  const title=lesson?`第 ${Number(lesson)} 课`:'开篇 · 跟读练习';
  videos.push({id,order:i+1,title,subtitle:'Karoline · English Shadowing',duration:Math.round(duration),hasAudio:!!audio,width:video.width,height:video.height,video:`atlas/extras/karoline/${id}.mp4`,poster:`atlas/extras/karoline/${id}.jpg`});
  mapping.push({id,original:name,sha256,originalBytes:(await fs.stat(input)).size,webBytes:(await fs.stat(target)).size,hasAudio:!!audio});
  console.log(`${id} ${title} ${Math.round(duration)}s ${audio?'audio':'NO AUDIO'}`);
}
await fs.writeFile(path.join(output,'index.json'),JSON.stringify({version:1,videos},null,2)+'\n');
await fs.writeFile('.local/karoline/source-mapping.json',JSON.stringify({source,generated:new Date().toISOString(),mapping},null,2)+'\n');
console.log('Prepared '+videos.length+' videos. Originals untouched.');
