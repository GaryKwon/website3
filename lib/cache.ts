/** Bounded last-known-good storage. It never authorizes skipping an upstream refresh. */
export class BoundedCache<K,V> {
  private values=new Map<K,{value:V;expires:number;bytes:number}>();
  private bytes=0;
  constructor(
    private maxEntries:number,
    private ttlMs:number,
    private maxBytes:number,
    private weigh:(value:V)=>number=value=>JSON.stringify(value).length*2,
    private now:()=>number=Date.now,
  ) {
    if(!Number.isInteger(maxEntries)||maxEntries<1||ttlMs<=0||maxBytes<1) throw new Error('Invalid fallback-cache limits');
  }
  private prune() {
    const now=this.now();
    for(const [key,entry] of this.values) if(entry.expires<=now) this.delete(key);
  }
  get(key:K):V|undefined {
    this.prune();
    const entry=this.values.get(key);
    if(!entry) return undefined;
    this.values.delete(key);this.values.set(key,entry);
    return entry.value;
  }
  set(key:K,value:V):void {
    this.prune();this.delete(key);
    const bytes=this.weigh(value);
    if(!Number.isFinite(bytes)||bytes<0||bytes>this.maxBytes) return;
    this.values.set(key,{value,bytes,expires:this.now()+this.ttlMs});this.bytes+=bytes;
    while(this.values.size>this.maxEntries||this.bytes>this.maxBytes) {
      const first=this.values.keys().next();
      if(first.done) break;
      this.delete(first.value);
    }
  }
  delete(key:K):boolean {
    const entry=this.values.get(key);
    if(!entry) return false;
    this.bytes-=entry.bytes;return this.values.delete(key);
  }
  clear():void {this.values.clear();this.bytes=0;}
  get size():number {this.prune();return this.values.size;}
  get retainedBytes():number {this.prune();return this.bytes;}
}
