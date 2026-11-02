import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync,openSync,closeSync,lstatSync,chmodSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {readJsonBody} from './accounts.mjs';
import {MAX_BODY,validDataset,safeTree} from './schema.mjs';

const DAY=86400000,hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(status,code,message=code)=>{throw Object.assign(new Error(message),{status,code});};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const allowedKey=k=>/^word-atlas:v2:[\w-]{1,80}$/.test(k)||['word-atlas:settings','word-atlas:appearance','word-atlas:reader:v1','word-atlas:reader-position:v1','word-atlas:view','word-atlas:galaxy-hello','word-atlas:splash'].includes(k)||/^word-atlas:extras:v1:[\w:.-]{1,250}$/.test(k)||(k.startsWith('word-atlas:illustration:')&&k.length<=250&&!/[\x00-\x1f\x7f]/.test(k));
export function validGuestState(state){
  if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).some(k=>k!=='records')||!state.records||typeof state.records!=='object'||Array.isArray(state.records)||!safeTree(state))return false;
  const entries=Object.entries(state.records);
  return entries.length<=20000&&entries.every(([k,v])=>allowedKey(k)&&typeof v==='string'&&v.length<=2_000_000);
}

export function createGuests({dbPath,origins,allowInsecureLocal=false,now=Date.now,guestQuotaBytes=20*1024*1024,totalQuotaBytes=512*1024*1024}){
  const path=resolve(dbPath),trusted=new Set(origins),hosts=new Set(origins.map(v=>new URL(v).host));
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  try{closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Guest DB must be a regular file');chmodSync(path,0o600);
  const db=new DatabaseSync(path,{allowExtension:false});
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
  if(tables.some(t=>!['guest_sessions','guest_states'].includes(t))){db.close();throw Error('Refusing a non-guest database');}
  db.exec(`PRAGMA max_page_count=${Math.ceil((totalQuotaBytes+16*1024*1024)/4096)};`);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS guest_sessions(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,csrf TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,last_active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guest_states(guest_id TEXT NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,dataset TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(guest_id,dataset));
    CREATE INDEX IF NOT EXISTS guest_expiry ON guest_sessions(last_active);`);
  const sql=s=>db.prepare(s),expiry=s=>Math.min(s.last_active+DAY,s.created_at+7*DAY);
  let closed=false;const rates=new Map();
  function cleanup(){const n=sql('DELETE FROM guest_sessions WHERE last_active<=? OR created_at<=?').run(now()-DAY,now()-7*DAY).changes;for(const [key,r]of rates)if(r.until<=now())rates.delete(key);return Number(n);}
  cleanup();const timer=setInterval(()=>{try{const deleted=cleanup();if(deleted)console.log(`Guest cleanup: ${deleted} expired identities removed`);}catch{console.error('Guest cleanup failed');}},300000);timer.unref();
  function rate(req,kind,max){const key=kind+':'+req.socket.remoteAddress;let r=rates.get(key);if(!r||r.until<=now()){if(rates.size>=10000)fail(429,'rate_limited');r={until:now()+60000,count:0};rates.set(key,r);}if(++r.count>max)fail(429,'rate_limited','请求过于频繁，请稍后重试。');}
  function token(req){const cookies=(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('wa_guest='));return cookies.length===1&&/^[a-f0-9]{64}$/.test(cookies[0].slice(9))?cookies[0].slice(9):null;}
  function session(req){const t=token(req);if(!t)return null;const s=sql('SELECT * FROM guest_sessions WHERE token_hash=?').get(hash(t));return s&&expiry(s)>now()?s:null;}
  const publicSession=s=>({id:s.id,name:s.name,createdAt:s.created_at,expiresAt:expiry(s),hardExpiresAt:s.created_at+7*DAY});
  function cookie(res,value,maxAge){res.setHeader('Set-Cookie',`wa_guest=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${allowInsecureLocal?'':'; Secure'}`);}
  function authenticate(req){const s=session(req);if(!s)fail(401,'guest_expired','游客身份已过期，请重新进入；正式账户不受影响。');if(req.headers['x-guest-id']!==s.id)fail(409,'guest_changed','游客身份已变化，请重新进入。');if(!equal(req.headers['x-guest-csrf'],s.csrf))fail(403,'csrf','请刷新游客会话后重试。');return s;}
  function dataset(url){const d=url.searchParams.get('dataset');if(!validDataset(d))fail(400,'invalid_dataset');return d;}
  async function route(req,res,url){
    const method=req.method,path=url.pathname;
    rate(req,'requests',180);
    if(method==='GET'&&path==='/api/guest/session'){
      const s=session(req);if(!s){if(token(req))cookie(res,'',0);return {guest:null};}return {guest:publicSession(s),csrfToken:s.csrf};
    }
    if(method!=='GET'&&!trusted.has(req.headers.origin))fail(403,'origin');
    if(method==='POST'&&path==='/api/guest/session'){
      if(req.headers['x-guest-request']!=='1')fail(403,'csrf');rate(req,'create',10);
      const body=await readJsonBody(req,1024);if(Object.keys(body).length)fail(400,'invalid_body');
      let s=session(req);
      if(s){authenticate(req);}else{
        if(req.headers['x-guest-id'])fail(401,'guest_expired');cleanup();
        if(sql('SELECT COUNT(*) n FROM guest_sessions').get().n>=10000)fail(503,'guest_capacity');
        const t=randomBytes(32).toString('hex'),id=randomUUID();
        s={id,token_hash:hash(t),csrf:randomBytes(32).toString('hex'),name:'游客_'+randomBytes(5).toString('hex').toUpperCase(),created_at:now(),last_active:now()};
        sql('INSERT INTO guest_sessions VALUES(?,?,?,?,?,?)').run(s.id,s.token_hash,s.csrf,s.name,s.created_at,s.last_active);cookie(res,t,86400);
      }
      return {guest:publicSession(s),csrfToken:s.csrf};
    }
    if(path==='/api/guest/session'&&method==='DELETE'){
      const s=authenticate(req);db.exec('BEGIN IMMEDIATE');
      try{
        if(url.searchParams.has('version')){
          const expected=url.searchParams.get('version'),current=sql("SELECT version FROM guest_states WHERE guest_id=? AND dataset='all'").get(s.id)?.version||0;
          if(!/^\d+$/.test(expected)||Number(expected)!==current)fail(409,'guest_conflict','游客记录已被其他页面更新，原记录已保留，请重新检查导入。');
        }
        sql('DELETE FROM guest_sessions WHERE id=?').run(s.id);db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      cookie(res,'',0);return {ok:true};
    }
    if(path!=='/api/guest/state'||!['GET','PUT'].includes(method))fail(404,'not_found');
    let s=authenticate(req);const d=dataset(url);
    if(method==='GET'){const r=sql('SELECT version,state FROM guest_states WHERE guest_id=? AND dataset=?').get(s.id,d);return {version:r?.version||0,state:r?JSON.parse(r.state):null,guest:publicSession(s)};}
    rate(req,'save',60);const body=await readJsonBody(req,MAX_BODY);s=authenticate(req);
    if(Object.keys(body).some(k=>!['version','state'].includes(k))||!Number.isSafeInteger(body.version)||body.version<0||!validGuestState(body.state))fail(400,'invalid_state');
    const text=JSON.stringify(body.state),bytes=Buffer.byteLength(text);
    db.exec('BEGIN IMMEDIATE');
    try{
      const r=sql('SELECT version,bytes FROM guest_states WHERE guest_id=? AND dataset=?').get(s.id,d);
      if((r?.version||0)!==body.version)fail(409,'guest_conflict','另一标签页已更新记录，请先导出本页数据，再重新载入服务器版本。');
      const own=sql('SELECT COALESCE(SUM(bytes),0) n FROM guest_states WHERE guest_id=?').get(s.id).n;
      const total=sql('SELECT COALESCE(SUM(bytes),0) n FROM guest_states').get().n;
      if(own-(r?.bytes||0)+bytes>guestQuotaBytes)fail(413,'guest_quota','游客暂存空间不足，请注册账户或导出备份。');
      if(total-(r?.bytes||0)+bytes>totalQuotaBytes)fail(507,'guest_capacity','临时存储容量已满，本页未保存，请导出备份。');
      sql('INSERT INTO guest_states VALUES(?,?,?,?,?) ON CONFLICT(guest_id,dataset) DO UPDATE SET version=excluded.version,state=excluded.state,bytes=excluded.bytes').run(s.id,d,body.version+1,text,bytes);
      // A write, never a read/heartbeat, extends the idle deadline.
      sql('UPDATE guest_sessions SET last_active=? WHERE id=?').run(now(),s.id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    s=session(req);cookie(res,token(req),Math.max(0,Math.ceil((expiry(s)-now())/1000)));
    return {version:body.version+1,guest:publicSession(s)};
  }
  return {cleanup,close(){if(!closed){closed=true;clearInterval(timer);db.close();}},async handle(req,res){
    if(!req.url?.startsWith('/api/guest/'))return false;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if(!req.socket.encrypted&&!(allowInsecureLocal&&local))fail(426,'https_required');
      if(!hosts.has(req.headers.host))fail(403,'host');
      if(req.headers.origin!==undefined&&!trusted.has(req.headers.origin))fail(403,'origin');
      send(200,await route(req,res,new URL(req.url,'https://'+req.headers.host)));
    }catch(e){const status=e.status||500;if(status===429)res.setHeader('Retry-After','60');send(status,{code:e.code&&status!==500?e.code:'internal_error',error:status===500?'游客暂存服务异常，本页变更尚未保存。':e.message});}
    return true;
  }};
}
