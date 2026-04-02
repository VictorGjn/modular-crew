
import type { SwarmBackend } from './types.js';
import { InProcessBackend } from './inProcessBackend.js';
import type { StudioProvider } from '../types.js';
export type BackendType = 'in-process';
export function getBackend(type: BackendType, provider: StudioProvider): SwarmBackend {
  switch(type){case 'in-process':return new InProcessBackend(provider);default:throw new Error(`Unknown backend: ${type}`);}
}
