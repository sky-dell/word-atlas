export interface IdleLogin {key:string;deadline:number}
interface Options {
  read:()=>IdleLogin|null; renew:()=>Promise<void>; revalidate:()=>Promise<void>;
  expire:()=>void; visible:()=>boolean; now?:()=>number;
}
/** Passive checks never renew. The server, not browser input, decides validity. */
export function createActivityMonitor(options:Options){
  const now=options.now??Date.now;
  let busy=false,disposed=false,expiredKey='',lastSent=-Infinity,pending=false,lastInput=-Infinity,key='';
  return {
    interact(){if(!disposed){pending=true;lastInput=now();}},
    async check(){
      if(disposed||busy)return;
      let current=options.read();if(!current){key='';expiredKey='';pending=false;lastSent=-Infinity;return;}
      if(current.key!==key){if(key)pending=false;key=current.key;expiredKey='';lastSent=-Infinity;}
      if(expiredKey===key){if(now()>=current.deadline)return;expiredKey='';}
      const captured=key;busy=true;
      try{
        if(now()>=current.deadline){
          try{await options.revalidate();}catch{/* Fail closed past the last confirmed deadline. */}
          if(disposed)return;
          current=options.read();
          if(!current||current.key!==captured)return;
          if(now()>=current.deadline){expiredKey=captured;pending=false;options.expire();return;}
        }
        if(pending&&options.visible()&&now()-lastSent>=60000&&now()-lastInput<=60000){
          pending=false;lastSent=now();
          try{await options.renew();}catch{await options.revalidate().catch(()=>{});}
        }
      }finally{busy=false;}
    },
    dispose(){disposed=true;pending=false;},
  };
}
