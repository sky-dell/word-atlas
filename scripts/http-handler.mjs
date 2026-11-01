import fs from 'node:fs';
import path from 'node:path';

const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.mp3':'audio/mpeg','.ogg':'audio/ogg','.txt':'text/plain; charset=utf-8'};
function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}

export function createApplication({root,accounts,guests,acmeRoot,secureOrigin='',allowInsecureLocal=false}) {
  root=path.resolve(root);
  function serve(req,res,file,base,requested,challenge=false) {
    let stat;
    try {
      if(!file.startsWith(base+path.sep)) {res.writeHead(403);res.end();return;}
      const real=fs.realpathSync(file);
      if(!real.startsWith(fs.realpathSync(base)+path.sep)) {res.writeHead(403);res.end();return;}
      stat=fs.statSync(real);
      if(!stat.isFile()) throw new Error('Not a regular file');
    } catch {res.writeHead(404);res.end('Not found');return;}
    let start=0,end=stat.size-1,status=200;
    const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':challenge?'no-store':requested.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'};
    if(req.headers.range) {
      const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!m||(!m[1]&&!m[2])) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      start=m[1]?Number(m[1]):Math.max(0,stat.size-Number(m[2]));
      end=m[1]&&m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;
      if(start>end||start>=stat.size) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length']=Math.max(0,end-start+1);
    res.writeHead(status,headers);
    if(req.method==='HEAD'||!stat.size) {res.end();return;}
    fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);
  }
  return async(req,res)=>{
    try {
      let requested;
      try {requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}
      catch {res.writeHead(400);res.end();return;}
      if(requested==='/api'||requested.startsWith('/api/')) {
        const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const available=accounts&&(req.socket.encrypted||(allowInsecureLocal&&local));
        if(!available) {
          if(requested==='/api/auth/session'&&req.method==='GET') json(res,200,{user:null,enabled:false,csrfToken:'',secureOrigin});
          else json(res,426,{error:'账户与游客暂存需要 HTTPS 安全连接。',code:'https_required',secureOrigin});
          return;
        }
        if(guests&&await guests.handle(req,res))return;
        if(await accounts.handle(req,res)) return;
        json(res,404,{error:'接口不存在。',code:'not_found'});return;
      }
      if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
      if(requested.startsWith('/.well-known/acme-challenge/')) {
        const token=requested.slice('/.well-known/acme-challenge/'.length);
        if(!acmeRoot||!/^[A-Za-z0-9_-]{1,256}$/.test(token)) {res.writeHead(404);res.end();return;}
        const base=path.resolve(acmeRoot,'.well-known/acme-challenge');
        serve(req,res,path.resolve(base,token),base,requested,true);return;
      }
      if(requested==='/words') requested='/';
      else if(requested.startsWith('/words/')) requested=requested.slice('/words'.length);
      // The compatibility prefix must never provide a second, unguarded API route.
      if(requested==='/api'||requested.startsWith('/api/')) {json(res,404,{error:'接口不存在。',code:'not_found'});return;}
      if(requested==='/health') {json(res,200,{status:'ok',service:'word-atlas'});return;}
      if(requested==='/app.htm') requested='/index.html';
      const file=path.resolve(root,'.'+(requested.endsWith('/')?requested+'index.html':requested));
      serve(req,res,file,root,requested);
    } catch {
      if(!res.headersSent) json(res,500,{error:'服务暂时不可用。',code:'internal_error'});
      else res.destroy();
    }
  };
}
