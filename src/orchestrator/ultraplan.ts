
import type { StudioProvider, ResolvedAgent } from '../types.js';
import { resolvePreset } from '../presets/index.js';
export interface PlanStep { id:string; agent:string; task:string; dependsOn:string[]; estimatedTokens:number; rationale:string; }
export interface UltraPlan { version:1; task:string; teamFile:string; createdAt:string; steps:PlanStep[]; totalEstimatedTokens:number; totalEstimatedCostUsd:number; validationErrors:string[]; notes:string[]; }
export async function generateUltraPlan(opts:{task:string;teamFile:string;teamAgents:string[];teamName:string;provider:StudioProvider;model?:string}):Promise<UltraPlan>{
  const pp=resolvePreset('plan');
  const agent:ResolvedAgent={id:'ultraplan',name:'Ultraplan',systemPrompt:pp.system??pp.role,model:opts.model??'mock-model',maxTurns:pp.maxTurns};
  const prompt=`Team: ${opts.teamName}\nAgents: ${opts.teamAgents.join(', ')}\nTask: ${opts.task}\nProduce JSON plan inside [PLAN]...[/PLAN] tags.`;
  let out=''; for await(const e of opts.provider.executeAgent(agent,prompt)){if(e.type==='text')out+=String(e.data);}
  const steps=parsePlan(out,opts.teamAgents);const errs=validatePlan(steps,opts.teamAgents);const tt=steps.reduce((s,x)=>s+x.estimatedTokens,0);
  return{version:1,task:opts.task,teamFile:opts.teamFile,createdAt:new Date().toISOString(),steps,totalEstimatedTokens:tt,totalEstimatedCostUsd:tt*.000003,validationErrors:errs,notes:[]};
}
function parsePlan(out:string,agents:string[]):PlanStep[]{
  const m=out.match(/\[PLAN\]\s*([\s\S]*?)\s*\[\/PLAN\]/i);if(m){try{const p=JSON.parse(m[1]);if(Array.isArray(p))return p;}catch{}}
  return agents.map((a,i)=>({id:'step-'+(i+1),agent:a,task:'Execute '+a+' role',dependsOn:i>0?['step-'+i]:[],estimatedTokens:5000,rationale:'Default plan for '+a}));
}
function validatePlan(steps:PlanStep[],agents:string[]):string[]{
  const errs:string[]=[];const ids=new Set(steps.map(s=>s.id));
  for(const s of steps){if(!agents.includes(s.agent))errs.push(`Step ${s.id} refs unknown agent "${s.agent}"`);for(const d of s.dependsOn)if(!ids.has(d))errs.push(`Step ${s.id} depends on unknown "${d}"`);}
  return errs;
}
export function shouldTriggerUltraplan(prompt:string):boolean{return/\bultraplan\b/i.test(prompt);}
