/** Request origin data on every call, including when running behind a Worker cache. */
// Workers reject combining `cache: no-store` with `cf.cacheTtl` overrides.
export const freshRequestOptions:RequestInit={cache:'no-store'};
export const freshRequestHeaders={'Cache-Control':'no-store, no-cache, max-age=0',Pragma:'no-cache'};

type WaitingRequest={grant:()=>void;cancel:()=>void};

/** Bound network/body parsing concurrency and remove aborted waiters immediately. */
export class UpstreamGate {
  private active=0;
  private queue:WaitingRequest[]=[];
  constructor(private maxActive=2,private maxQueued=16) {
    if(!Number.isInteger(maxActive)||maxActive<1||!Number.isInteger(maxQueued)||maxQueued<0) throw new Error('Invalid upstream concurrency limits');
  }
  private acquire(signal?:AbortSignal):Promise<()=>void> {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted) {reject(signal.reason??new DOMException('Request aborted','AbortError'));return;}
      let queued:WaitingRequest|undefined;
      const abort=()=>{
        if(queued) {
          const index=this.queue.indexOf(queued);
          if(index>=0) this.queue.splice(index,1);
        }
        signal?.removeEventListener('abort',abort);
        reject(signal?.reason??new DOMException('Request aborted','AbortError'));
      };
      const grant=()=>{
        signal?.removeEventListener('abort',abort);
        if(signal?.aborted) {abort();return;}
        this.active++;
        let released=false;
        resolve(()=>{
          if(released) return;
          released=true;
          this.active--;
          this.drain();
        });
      };
      if(this.active<this.maxActive) {grant();return;}
      if(this.queue.length>=this.maxQueued) {
        const error=new Error('공식 조회 요청이 많아 새 요청을 대기시킬 수 없습니다.');
        error.name='UpstreamBusyError';reject(error);return;
      }
      queued={grant,cancel:abort};
      this.queue.push(queued);
      signal?.addEventListener('abort',abort,{once:true});
    });
  }
  private drain():void {
    while(this.active<this.maxActive && this.queue.length) this.queue.shift()!.grant();
  }
  async run<T>(action:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    const release=await this.acquire(signal);
    try {
      if(signal?.aborted) throw signal.reason??new DOMException('Request aborted','AbortError');
      return await action();
    } finally {release();}
  }
  get state():{active:number;queued:number} {return {active:this.active,queued:this.queue.length};}
}

export const upstreamGate=new UpstreamGate(2,16);
export const getUpstreamRuntimeState=()=>upstreamGate.state;

/** Bound streams before accumulating their full body in the 128 MB Worker isolate. */
export async function readBoundedText(response:Response,maxBytes:number):Promise<string> {
  if(!response.body) return '';
  const declared=Number(response.headers.get('Content-Length'));
  if(Number.isFinite(declared)&&declared>maxBytes) {
    await response.body.cancel();
    throw new Error('공식 응답 크기 제한을 초과했습니다.');
  }
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  const chunks:string[]=[];
  let total=0;
  try {
    while(true) {
      const {value,done}=await reader.read();
      if(done) break;
      total+=value.byteLength;
      if(total>maxBytes) throw new Error('공식 응답 크기 제한을 초과했습니다.');
      chunks.push(decoder.decode(value,{stream:true}));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch(error) {
    try {await reader.cancel();} catch { /* The request may already have aborted. */ }
    throw error;
  } finally {reader.releaseLock();}
}
