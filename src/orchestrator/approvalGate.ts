
import { createInterface } from 'node:readline';
export interface ApprovalConfig { approval:boolean; approvalMessage?:string; approvalTimeout?:number; ciMode?:boolean; ciAutoApprove?:boolean; }
export interface ApprovalResult { approved:boolean; respondedBy:'human'|'ci'|'timeout'; feedback?:string; durationMs:number; }
export async function requestApproval(stepId:string,cfg:ApprovalConfig):Promise<ApprovalResult>{
  const s=Date.now();const msg=cfg.approvalMessage??`Step "${stepId}" requires approval. (y/n): `;
  if(cfg.ciMode)return{approved:cfg.ciAutoApprove??false,respondedBy:'ci',durationMs:Date.now()-s};
  const ms=(cfg.approvalTimeout??300)*1000;
  return new Promise(resolve=>{const rl=createInterface({input:process.stdin,output:process.stdout});
  const t=setTimeout(()=>{rl.close();resolve({approved:false,respondedBy:'timeout',durationMs:Date.now()-s});},ms);
  rl.question(msg,(a:string)=>{clearTimeout(t);rl.close();resolve({approved:['y','yes'].includes(a.trim().toLowerCase()),respondedBy:'human',feedback:a.trim(),durationMs:Date.now()-s});});});
}
export function logApprovalEvent(store:{appendEvent:(r:string,e:any)=>void},ev:{runId:string;stepId:string;result:ApprovalResult;timestamp:string}):void{
  store.appendEvent(ev.runId,{timestamp:Date.now(),runId:ev.runId,stepId:ev.stepId,type:ev.result.approved?'step.human_approved':'step.skip',data:{...ev.result}});
}
