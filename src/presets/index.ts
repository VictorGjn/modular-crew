
export interface AgentPreset { role:string; maxTurns:number; system?:string; tools?:string[]; model?:string; }
export const PRESETS:Record<string,AgentPreset> = {
  explore:{role:'Explore codebase structure, find relevant files, map dependencies',maxTurns:20,system:'You are an explorer agent. Navigate codebases, identify key files, map dependencies.'},
  plan:{role:'Create detailed implementation plan with task breakdown',maxTurns:10,system:'You are a planning agent. Break tasks into steps, identify risks, produce plans.'},
  verify:{role:'Verify implementation against spec, run tests, check edge cases',maxTurns:15,system:'You are a verification agent. Check implementations, run tests, find issues.'},
  implement:{role:'Implement code changes following the plan exactly',maxTurns:25,system:'You are an implementation agent. Write clean code following the plan.'},
  review:{role:'Review code for quality, security, performance issues',maxTurns:10,system:'You are a review agent. Check quality, security, performance.'},
  pm:{role:'Product manager: prioritize, write specs, validate against user needs',maxTurns:10,system:'You are a PM agent. Prioritize, spec, validate.'},
};
export function resolvePreset(name:string,overrides?:Partial<AgentPreset>):AgentPreset{
  const p=PRESETS[name];if(!p)throw new Error(`Unknown agent preset: "${name}". Available: ${Object.keys(PRESETS).join(', ')}`);
  if(!overrides)return{...p};return{...p,...overrides,role:overrides.role?p.role+'. Additional: '+overrides.role:p.role,tools:overrides.tools?[...(p.tools??[]),...overrides.tools]:p.tools};
}
export function listPresets():Array<{name:string;role:string;maxTurns:number}>{return Object.entries(PRESETS).map(([n,p])=>({name:n,role:p.role,maxTurns:p.maxTurns}));}
