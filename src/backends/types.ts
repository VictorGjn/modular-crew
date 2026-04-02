
import type { AgentMessage } from '../facts/mailbox.js';
export interface AgentRunConfig { agentId:string; systemPrompt:string; model:string; maxTurns:number; input:string; tools?:string[]; }
export interface AgentResult { agentId:string; output:string; status:'completed'|'failed'|'killed'; tokensIn:number; tokensOut:number; durationMs:number; error?:string; }
export interface AgentHandle { id:string; status:'running'|'completed'|'failed'|'killed'; result?:AgentResult; }
export interface SwarmBackend {
  spawn(agentId:string,config:AgentRunConfig):Promise<AgentHandle>;
  send(agentId:string,message:AgentMessage):Promise<void>;
  kill(agentId:string):Promise<void>;
  waitAll():Promise<Map<string,AgentResult>>;
  shutdown():Promise<void>;
}
