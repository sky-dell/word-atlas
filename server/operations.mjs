import os from 'node:os';
import http from 'node:http';
import {statfs} from 'node:fs/promises';
const publicFailure=()=>Object.assign(new Error('系统监控或证书组件暂不可用，请稍后重试。'),{status:503,code:'operations_unavailable'});
// Kept as an inert compatibility export: legacy callers cannot restart collection.
export async function collectServices(){
  return {services:[],disabled:true,sampledAt:Date.now()};
}
export function helperRequest(action,payload={},socketPath='/run/word-atlas-admin/control.sock',context){
  if(!['certificate','events','stage','apply','rollback','automatic','auto-install'].includes(action))return Promise.reject(publicFailure());
  const body=JSON.stringify({action,payload,...(context?{context}:{})});if(Buffer.byteLength(body)>140000)return Promise.reject(publicFailure());
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let chunks=[],size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){req.destroy();reject(publicFailure());}else chunks.push(chunk);});
      res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200){reject(Object.assign(new Error(typeof data.error==='string'?data.error:'证书操作未完成。'),{status:res.statusCode>=400&&res.statusCode<500?res.statusCode:503,code:'certificate_operation_failed'}));return;}resolve(data);}catch{reject(publicFailure());}});
      res.on('error',()=>reject(publicFailure()));
    });req.setTimeout(15000,()=>req.destroy());req.on('error',()=>reject(publicFailure()));req.end(body);
  });
}
export function createOperations({helperSocket,mailEnabled=false,guestEnabled=false,accountsEnabled=false,tlsEnabled=false,dataPath=process.cwd()}={}){
  return {
    request:(action,payload,context)=>helperRequest(action,payload,helperSocket,context),
    async overview(){
      const disk=await statfs(dataPath),total=disk.blocks*disk.bsize,free=disk.bavail*disk.bsize,memTotal=os.totalmem(),memFree=os.freemem();
      return {project:{uptimeSeconds:Math.floor(process.uptime()),startedAt:Math.round(Date.now()-process.uptime()*1000)},host:{uptimeSeconds:Math.floor(os.uptime()),load:os.loadavg(),cpus:os.availableParallelism(),memory:{total:memTotal,free:memFree,used:memTotal-memFree},disk:{total,free,used:total-free}},checks:[['账户数据库',accountsEnabled],['游客暂存',guestEnabled],['邮件服务',mailEnabled],['HTTPS',tlsEnabled]].map(([name,ok])=>({name,status:ok?'ok':'unavailable',detail:ok?'组件已加载 / 配置就绪':'组件未启用或配置未完成'}))};
    },
  };
}
