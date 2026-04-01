
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export interface ConsolidationInput { currentRunFacts:Array<{key:string;value:string;source:string;timestamp:number}>; pastFacts:Array<{key:string;value:string;source:string;timestamp:number}>; memoryDir:string; }
export interface ConsolidatedMemory { facts:Array<{key:string;value:string;sources:string[];lastUpdated:number;confidence:number}>; pruned:string[]; mergedCount:number; }
export function orient(input:ConsolidationInput):string[]{const k=new Set<string>();for(const f of[...input.currentRunFacts,...input.pastFacts])k.add(f.key);return[...k];}
export function gather(keys:string[],input:ConsolidationInput):Map<string,Array<{value:string;source:string;timestamp:number}>>{
  const g=new Map();for(const k of keys){g.set(k,[...input.currentRunFacts,...input.pastFacts].filter(f=>f.key===k).sort((a,b)=>a.timestamp-b.timestamp));}return g;
}
export function consolidate(gathered:Map<string,Array<{value:string;source:string;timestamp:number}>>):ConsolidatedMemory{
  const facts:ConsolidatedMemory['facts']=[];let mc=0;
  for(const[k,es]of gathered){if(!es.length)continue;const l=es[es.length-1];const srcs=[...new Set(es.map(e=>e.source))];facts.push({key:k,value:l.value,sources:srcs,lastUpdated:l.timestamp,confidence:Math.min(1,.5+srcs.length*.1)});if(es.length>1)mc++;}
  return{facts,pruned:[],mergedCount:mc};
}
export function prune(mem:ConsolidatedMemory,maxDays=30):ConsolidatedMemory{
  const cut=Date.now()-maxDays*86400000;const pr:string[]=[];const keep=mem.facts.filter(f=>{if(f.lastUpdated<cut){pr.push(f.key);return false;}return true;});
  return{facts:keep,pruned:[...mem.pruned,...pr],mergedCount:mem.mergedCount};
}
export function saveMemory(mem:ConsolidatedMemory,dir:string):void{mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'consolidated-facts.json'),JSON.stringify(mem,null,2));}
export function loadMemory(dir:string):ConsolidatedMemory|null{const p=join(dir,'consolidated-facts.json');if(!existsSync(p))return null;try{return JSON.parse(readFileSync(p,'utf-8'));}catch{return null;}}
export function runConsolidation(input:ConsolidationInput):ConsolidatedMemory{const k=orient(input);const g=gather(k,input);const c=consolidate(g);const p=prune(c);saveMemory(p,input.memoryDir);return p;}
