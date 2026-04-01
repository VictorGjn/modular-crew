
import type { SwarmBackend, AgentRunConfig, AgentResult, AgentHandle } from './types.js';
import type { AgentMessage } from '../facts/mailbox.js';
import type { StudioProvider } from '../types.js';
export class InProcessBackend implements SwarmBackend {
  private handles=new Map<string,AgentHandle>(); private promises=new Map<string,Promise<AgentResult>>(); private ctrls=new Map<string,AbortController>();
  constructor(private provider:StudioProvider){}
  async spawn(id:string,cfg:AgentRunConfig):Promise<AgentHandle>{
    const h:AgentHandle={id,status:'running'}; this.handles.set(id,h);
    const c=new AbortController(); this.ctrls.set(id,c);
    const p=this.exec(id,cfg,c.signal); this.promises.set(id,p);
    p.then(r=>{h.status=r.status==='completed'?'completed':'failed';h.result=r;}).catch(()=>{h.status='failed';}); return h;
  }
  async send(_id:string,_msg:AgentMessage):Promise<void>{}
  async kill(id:string):Promise<void>{this.ctrls.get(id)?.abort();const h=this.handles.get(id);if(h)h.status='killed';}
  async waitAll():Promise<Map<string,AgentResult>>{
    const e=[...this.promises.entries()]; const s=await Promise.allSettled(e.map(([_,p])=>p));
    const r=new Map<string,AgentResult>();
    for(let i=0;i<e.length;i++){const[id]=e[i];const v=s[i];r.set(id,v.status==='fulfilled'?v.value:{agentId:id,output:'',status:'failed',tokensIn:0,tokensOut:0,durationMs:0,error:String((v as PromiseRejectedResult).reason)});}
    return r;
  }
  async shutdown():Promise<void>{for(const c of this.ctrls.values())c.abort();this.handles.clear();this.promises.clear();this.ctrls.clear();}
  private async exec(id:string,cfg:AgentRunConfig,sig:AbortSignal):Promise<AgentResult>{
    const s=Date.now();let o='',ti=0,to=0;
    try{const a={id,name:id,systemPrompt:cfg.systemPrompt,model:cfg.model,maxTurns:cfg.maxTurns,tools:cfg.tools};
    for await(const e of this.provider.executeAgent(a,cfg.input,sig)){if(e.type==='text')o+=String(e.data);if(e.tokensIn)ti+=e.tokensIn;if(e.tokensOut)to+=e.tokensOut;}
    return{agentId:id,output:o,status:'completed',tokensIn:ti,tokensOut:to,durationMs:Date.now()-s};
    }catch(err){return{agentId:id,output:o,status:'failed',tokensIn:ti,tokensOut:to,durationMs:Date.now()-s,error:err instanceof Error?err.message:String(err)};}
  }
}
