
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export interface BackgroundTaskDef { name:string; trigger:'post-run'; minInterval:number; role:string; phases:string[]; }
export interface BackgroundTaskResult { name:string; status:'completed'|'skipped'|'failed'; reason?:string; durationMs:number; output?:string; }
export function shouldRunTask(task:BackgroundTaskDef,dir:string):boolean{
  const lock=join(dir,'.'+task.name+'.lock');const lr=join(dir,'.'+task.name+'.lastrun');
  if(existsSync(lock))return false;
  if(existsSync(lr)){try{const t=parseInt(readFileSync(lr,'utf-8').trim(),10);if(Date.now()-t<task.minInterval*1000)return false;}catch{}}
  return true;
}
export function acquireLock(task:BackgroundTaskDef,dir:string):boolean{
  const lock=join(dir,'.'+task.name+'.lock');if(existsSync(lock))return false;mkdirSync(dir,{recursive:true});writeFileSync(lock,String(Date.now()));return true;
}
export function releaseLock(task:BackgroundTaskDef,dir:string):void{
  const lock=join(dir,'.'+task.name+'.lock');const lr=join(dir,'.'+task.name+'.lastrun');try{unlinkSync(lock);}catch{}writeFileSync(lr,String(Date.now()));
}
export async function runBackgroundTasks(tasks:BackgroundTaskDef[],dir:string,exec:(t:BackgroundTaskDef)=>Promise<string>):Promise<BackgroundTaskResult[]>{
  const res:BackgroundTaskResult[]=[]; for(const t of tasks){if(!shouldRunTask(t,dir)){res.push({name:t.name,status:'skipped',reason:'interval/lock',durationMs:0});continue;}
  if(!acquireLock(t,dir)){res.push({name:t.name,status:'skipped',reason:'lock held',durationMs:0});continue;}
  const s=Date.now();try{const o=await exec(t);res.push({name:t.name,status:'completed',durationMs:Date.now()-s,output:o});}catch(e){res.push({name:t.name,status:'failed',reason:e instanceof Error?e.message:String(e),durationMs:Date.now()-s});}finally{releaseLock(t,dir);}}
  return res;
}
