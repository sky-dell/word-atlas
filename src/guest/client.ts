export interface Guest {id:string;name:string;createdAt:number;expiresAt:number;hardExpiresAt:number}
export class GuestError extends Error {constructor(message:string,public code='',public status=0){super(message);}}
export class GuestClient {
  private id='';private csrf='';private epoch=0;private requests=new Set<AbortController>();
  setSession(id:string,csrf:string){if(id!==this.id){this.epoch++;this.requests.forEach(c=>c.abort());this.requests.clear();}this.id=id;this.csrf=csrf;}
  async request<T>(path:string,method='GET',body?:unknown):Promise<T>{
    const epoch=this.epoch,abort=new AbortController();this.requests.add(abort);const timer=setTimeout(()=>abort.abort(),20000);
    try{
      const r=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:abort.signal,headers:{Accept:'application/json','Content-Type':'application/json','X-Guest-Request':'1','X-Guest-ID':this.id,'X-Guest-CSRF':this.csrf},body:body===undefined?undefined:JSON.stringify(body)});
      if(epoch!==this.epoch||abort.signal.aborted)throw new DOMException('游客身份已变化','AbortError');
      if(!r.headers.get('content-type')?.includes('application/json'))throw new GuestError('游客服务暂时不可用，请稍后再试。');
      const data=await r.json();if(epoch!==this.epoch)throw new DOMException('游客身份已变化','AbortError');
      if(!r.ok)throw new GuestError(data.error||'游客记录尚未保存，请重试。',data.code,r.status);
      return data;
    }finally{clearTimeout(timer);this.requests.delete(abort);}
  }
}
export const guestClient=new GuestClient();
