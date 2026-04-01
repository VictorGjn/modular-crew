
import { spawn } from 'node:child_process';
export type HookPhase = 'before_step'|'after_step'|'before_run'|'after_run';
export type OnFailPolicy = 'abort'|'continue';
export interface HookDefinition { name:string; run:string; on_fail?:OnFailPolicy; timeout?:number; }
export interface HookContext { runId:string; stepId?:string; agentId?:string; task?:string; env?:Record<string,string>; }
export interface HookResult { name:string; phase:HookPhase; exitCode:number; stdout:string; stderr:string; durationMs:number; success:boolean; aborted:boolean; }
export interface HooksConfig { before_step?:HookDefinition[]; after_step?:HookDefinition[]; before_run?:HookDefinition[]; after_run?:HookDefinition[]; }
function exec(cmd:string,ms:number,env?:Record<string,string>):Promise<{exitCode:number;stdout:string;stderr:string}>{
  return new Promise(r=>{const p=spawn('sh',['-c',cmd],{timeout:ms,env:{...process.env,...env}});let o='',e='';p.stdout?.on('data',(d:Buffer)=>{o+=d;});p.stderr?.on('data',(d:Buffer)=>{e+=d;});p.on('close',(c:number|null)=>{r({exitCode:c??1,stdout:o.trim(),stderr:e.trim()});});p.on('error',(err:Error)=>{r({exitCode:1,stdout:'',stderr:err.message});});});
}
export async function runHooks(phase:HookPhase,hooks:HookDefinition[],ctx:HookContext):Promise<HookResult[]>{
  const res:HookResult[]=[];let abort=false;
  for(const h of hooks){if(abort){res.push({name:h.name,phase,exitCode:-1,stdout:'',stderr:'Skipped',durationMs:0,success:false,aborted:true});continue;}
  const t=h.timeout??30000;const env:Record<string,string>={CREW_RUN_ID:ctx.runId,CREW_PHASE:phase,...(ctx.stepId?{CREW_STEP_ID:ctx.stepId}:{}),...(ctx.agentId?{CREW_AGENT_ID:ctx.agentId}:{}),...ctx.env};
  const s=Date.now();const{exitCode:c,stdout:o,stderr:e}=await exec(h.run,t,env);const d=Date.now()-s;const ok=c===0;
  res.push({name:h.name,phase,exitCode:c,stdout:o,stderr:e,durationMs:d,success:ok,aborted:false});if(!ok&&(h.on_fail??'continue')==='abort')abort=true;}
  return res;
}
