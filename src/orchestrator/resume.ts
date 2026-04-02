
import type { FactBus } from '../facts/fact-bus.js';
export interface ResumeState { runId:string; completedSteps:string[]; failedSteps:string[]; pendingSteps:string[]; facts:Array<{key:string;value:string;source:string;timestamp:number;status:string}>; }
export function loadResumeState(store:{getRun:(id:string)=>any;getRunSteps:(id:string)=>any[];getRunFacts:(id:string)=>any[]},runId:string):ResumeState{
  const run=store.getRun(runId);if(!run)throw new Error(`Run ${runId} not found`);
  const steps=store.getRunSteps(runId);const facts=store.getRunFacts(runId);
  return{runId,completedSteps:steps.filter((s:any)=>s.status==='succeeded').map((s:any)=>s.step_id),failedSteps:steps.filter((s:any)=>s.status==='failed').map((s:any)=>s.step_id),pendingSteps:steps.filter((s:any)=>!['succeeded','skipped'].includes(s.status)).map((s:any)=>s.step_id),facts:facts.map((f:any)=>({key:f.key,value:f.value,source:f.source,timestamp:new Date(f.published_at).getTime(),status:f.type}))};
}
export function restoreFacts(factBus:FactBus,state:ResumeState):void{for(const f of state.facts)factBus.publish({key:f.key,value:f.value,source:f.source,timestamp:f.timestamp,status:f.status as any});}
export function getStepsToExecute(order:string[],state:ResumeState,mode:'resume'|'retry'):string[]{
  if(mode==='retry')return order.filter(s=>state.failedSteps.includes(s));return order.filter(s=>!state.completedSteps.includes(s));
}
