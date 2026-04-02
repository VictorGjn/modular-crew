
export interface StepSummary { runId:string;stepId:string;agentId:string;summary:string;tokensUsed?:number;costUsd?:number;durationMs?:number; }
export interface RunSummaryData { runId:string;teamName:string;task:string;totalSteps:number;succeededSteps:number;failedSteps:number;skippedSteps:number;totalTokens:number;totalCostUsd:number;totalDurationMs:number;stepSummaries:StepSummary[];keyDecisions:string[];artifacts:string[]; }
export function initSummaryTable(db:any):void{db.exec(`CREATE TABLE IF NOT EXISTS step_summaries(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,agent_id TEXT NOT NULL,summary TEXT NOT NULL,tokens_used INTEGER,cost_usd REAL,duration_ms INTEGER,created_at TEXT DEFAULT(datetime('now')));CREATE INDEX IF NOT EXISTS idx_ss_run ON step_summaries(run_id);`);}
export function summarizeStepOutput(output:string,agentId:string,stepId:string):string{
  if(!output||!output.trim())return`[${agentId}] No output produced for step ${stepId}.`;
  const lines=output.split('\n').filter(l=>l.trim());const hdrs=lines.filter(l=>l.startsWith('#')).map(l=>l.replace(/^#+\s*/,''));const buls=lines.filter(l=>/^\s*[-*]\s/.test(l)).map(l=>l.replace(/^\s*[-*]\s+/,''));
  const p:string[]=[];if(hdrs.length)p.push('Covered: '+hdrs.slice(0,3).join(', '));if(buls.length)p.push('Key points: '+buls.slice(0,3).join('; '));if(!p.length)p.push(lines[0].substring(0,150));
  return`[${agentId}] ${p.join('. ')}`.substring(0,300);
}
export function summarizeRun(runId:string,teamName:string,task:string,steps:Array<{stepId:string;status:string;agentId?:string;output?:string;tokensIn?:number;tokensOut?:number;costUsd?:number;durationMs?:number}>):RunSummaryData{
  const ss:StepSummary[]=[];const kd:string[]=[];const ar:string[]=[];let tt=0,tc=0,td=0,ok=0,fail=0,skip=0;
  for(const s of steps){if(s.status==='succeeded')ok++;else if(s.status==='failed')fail++;else if(s.status==='skipped')skip++;const t=(s.tokensIn??0)+(s.tokensOut??0);tt+=t;tc+=s.costUsd??0;td+=s.durationMs??0;
  if(s.output&&s.agentId)ss.push({runId,stepId:s.stepId,agentId:s.agentId,summary:summarizeStepOutput(s.output,s.agentId,s.stepId),tokensUsed:t,costUsd:s.costUsd,durationMs:s.durationMs});}
  return{runId,teamName,task,totalSteps:steps.length,succeededSteps:ok,failedSteps:fail,skippedSteps:skip,totalTokens:tt,totalCostUsd:tc,totalDurationMs:td,stepSummaries:ss,keyDecisions:kd,artifacts:ar};
}
export function saveStepSummary(db:any,s:StepSummary):void{db.prepare('INSERT INTO step_summaries(run_id,step_id,agent_id,summary,tokens_used,cost_usd,duration_ms)VALUES(?,?,?,?,?,?,?)').run(s.runId,s.stepId,s.agentId,s.summary,s.tokensUsed??null,s.costUsd??null,s.durationMs??null);}
export function loadStepSummaries(db:any,runId:string):StepSummary[]{return db.prepare('SELECT*FROM step_summaries WHERE run_id=? ORDER BY id').all(runId).map((r:any)=>({runId:r.run_id,stepId:r.step_id,agentId:r.agent_id,summary:r.summary,tokensUsed:r.tokens_used,costUsd:r.cost_usd,durationMs:r.duration_ms}));}
