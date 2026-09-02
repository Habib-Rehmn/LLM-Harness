import { createForgeContext } from '@forge/kernel-context';
import { decisionEvent, pluginName } from '@forge/kernel-contracts';

export interface ToolRequest {
  readonly name: string;
  readonly mutatesWorkspace: boolean;
}

export interface InterceptionChainResult {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly trace: readonly string[];
  readonly listenersBeforeUnload: number;
  readonly listenersAfterUnload: number;
}

const PRE_EXECUTE = decisionEvent<ToolRequest>('tools.pre-execute');

export async function runInterceptionChain(): Promise<InterceptionChainResult> {
  const root = createForgeContext('agent');
  const telemetry = root.scope({
    name: 'telemetry-hook',
    parentPlugin: pluginName('telemetry-hook'),
  });
  const managedPolicy = root.scope({
    name: 'managed-policy',
    parentPlugin: pluginName('managed-policy'),
  });
  const trace: string[] = [];

  telemetry.on(PRE_EXECUTE, async (request, next) => {
    trace.push(`observed:${request.name}`);
    return next();
  });
  managedPolicy.on(PRE_EXECUTE, (request) => {
    trace.push('managed-policy');
    return request.mutatesWorkspace ? ('deny' as const) : ('delegate' as const);
  });

  const listenersBeforeUnload = root.inspectEvents().events[0]?.listeners.length ?? 0;
  const decision = await root.decide(
    PRE_EXECUTE,
    { name: 'shell', mutatesWorkspace: true },
    () => 'allow',
  );

  await managedPolicy.dispose();
  await telemetry.dispose();
  const listenersAfterUnload = root.inspectEvents().events[0]?.listeners.length ?? 0;
  await root.dispose();

  return Object.freeze({
    decision,
    trace: Object.freeze(trace),
    listenersBeforeUnload,
    listenersAfterUnload,
  });
}
