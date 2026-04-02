
import type { MailboxStore } from '../facts/mailbox.js';
import type { StudioProvider, ResolvedAgent, Fact } from '../types.js';
import type { FactBus } from '../facts/fact-bus.js';
export interface CoordinatorConfig { scratchpad: boolean; maxWorkers: number; maxRounds: number; }
export interface CoordinatorAgentDef { name: string; role: string; isCoordinator?: boolean; system?: string; model?: string; maxTurns?: number; }
export interface CoordinatorTeam { name: string; task: string; config: CoordinatorConfig; agents: Record<string, CoordinatorAgentDef>; }
export interface CoordinatorResult { runId: string; status: 'succeeded'|'failed'; rounds: number; agentResults: Map<string,string>; facts: Fact[]; totalTokensIn: number; totalTokensOut: number; durationMs: number; }
export class CoordinatorEngine {
  constructor(private mailbox: MailboxStore, private provider: StudioProvider, private factBus: FactBus) {}
  async run(team: CoordinatorTeam, runId: string): Promise<CoordinatorResult> {
    const start = Date.now(); let tIn=0,tOut=0; const results = new Map<string,string>();
    const cfg = { maxRounds:10, ...team.config };
    const coordName = Object.entries(team.agents).find(([_,a])=>a.isCoordinator)?.[0];
    if (!coordName) throw new Error('No coordinator agent found');
    const allWorkers = Object.keys(team.agents).filter(n=>n!==coordName);
    const workers = allWorkers.slice(0, cfg.maxWorkers ?? allWorkers.length);
    const agents = new Map<string,ResolvedAgent>();
    for (const [n,d] of Object.entries(team.agents)) agents.set(n,{id:n,name:n,systemPrompt:d.system??('You are '+n+'. '+d.role),model:d.model??'mock-model',maxTurns:d.maxTurns??15});
    let round=0,done=false; const ca=agents.get(coordName)!;
    while(!done&&round<cfg.maxRounds){
      round++;
      let input=round===1?'Task: '+team.task+'\nWorkers: '+workers.join(', ')+'\nUse [DISPATCH:w]task[/DISPATCH]. [DONE] when finished.':'';
      if(round>1){const ms=this.mailbox.receiveMessages(runId,coordName).filter(m=>!m.read);input='Round '+round+':\n'+ms.map(m=>'['+m.from+']: '+m.content).join('\n')+'\n[DONE] or dispatch more.';this.mailbox.markAllRead(runId,coordName);}
      let out=''; for await(const e of this.provider.executeAgent(ca,input)){if(e.type==='text')out+=String(e.data);if(e.tokensIn)tIn+=e.tokensIn;if(e.tokensOut)tOut+=e.tokensOut;}
      results.set(coordName+'_r'+round,out);
      if(out.includes('[DONE]')){done=true;break;}
      const rx=/\[DISPATCH:(\w+)\]\s*([\s\S]*?)\s*\[\/DISPATCH\]/g; const ds:Array<{w:string;t:string}>=[]; let m;
      while((m=rx.exec(out))!==null)ds.push({w:m[1],t:m[2].trim()});
      if(!ds.length&&round>1){done=true;break;}
      for(const d of ds)this.mailbox.sendMessage(runId,coordName,d.w,d.t,'task');
      await Promise.allSettled(ds.map(async d=>{
        const ag=agents.get(d.w); if(!ag){this.mailbox.sendMessage(runId,d.w,coordName,'Unknown','result');return;}
        let o=''; for await(const e of this.provider.executeAgent(ag,d.t)){if(e.type==='text')o+=String(e.data);if(e.tokensIn)tIn+=e.tokensIn;if(e.tokensOut)tOut+=e.tokensOut;}
        results.set(d.w,o); this.mailbox.sendMessage(runId,d.w,coordName,o,'result');
      }));
    }
    return{runId,status:'succeeded',rounds:round,agentResults:results,facts:[],totalTokensIn:tIn,totalTokensOut:tOut,durationMs:Date.now()-start};
  }
}
