import http from 'node:http';
import {randomBytes} from 'node:crypto';
const actions=new Set(['certificate','events','stage','apply','rollback','automatic','auto-install']);
export function createHelperServer({manager,journal}){
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
    if(req.method!=='POST'||req.url!=='/'){send(405,{error:'不支持的操作。'});return;}
    if(active>=4){send(503,{error:'操作繁忙，请稍后重试。'});return;}
    active++;
    let operation=null,committed=false;
    try{
      const declared=Number(req.headers['content-length']||0);if(declared>140000)throw {status:413};
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>140000)throw {status:413};chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw {status:400};}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','payload','context'].includes(k))||!actions.has(body.action))throw {status:400};
      const {action,payload={}}=body;
      if(!payload||typeof payload!=='object'||Array.isArray(payload))throw {status:400};
      const keys=Object.keys(payload);
      if(action==='stage'){
        if(keys.length!==2||keys.some(k=>!['certificatePem','privateKeyPem'].includes(k))||typeof payload.certificatePem!=='string'||typeof payload.privateKeyPem!=='string')throw {status:400};
      }else if(action==='apply'){
        if(keys.length!==1||!/^[a-f0-9]{32}$/.test(payload.stageId))throw {status:400};
      }else if(keys.length)throw {status:400};
      if(body.context!==undefined&&(!body.context||typeof body.context!=='object'||Array.isArray(body.context)||Object.keys(body.context).length!==2||!/^[a-f0-9]{32}$/.test(body.context.operationId)||!/^[A-Za-z0-9_-]{1,80}$/.test(body.context.actorId)))throw {status:400};
      if(action==='events'){send(200,{events:journal?.list()??[]});return;}
      const method={certificate:'status','auto-install':'autoInstall'}[action]||action;
      if(action!=='certificate'){
        if(!journal)throw {status:503};
        operation={id:body.context?.operationId??randomBytes(16).toString('hex'),actorId:body.context?.actorId??'system',action};
        journal.start(operation);
      }
      const result=await manager[method](payload);committed=true;
      if(operation)journal.finish(operation.id,'success',result.certificate?.fingerprint256);
      send(200,result);
    }catch(error){
      if(operation)try{journal.finish(operation.id,operation.action==='stage'&&!committed?'failure':'uncertain',null);}catch{/* The durable admission remains visible if outcome persistence fails. */}
      const status=[400,403,404,409,410,413,422,429,503].includes(error.status)?error.status:400;
      send(status,{error:status===413?'上传文件过大。':'操作未完成，请检查证书域名、有效期、完整证书链与私钥配对，或稍后重试。',code:'operation_rejected'});
    }finally{active--;}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=32;server.keepAliveTimeout=1000;
  return server;
}
