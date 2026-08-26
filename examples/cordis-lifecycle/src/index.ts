import { Context, type Plugin } from '@deepseek-ai/cordis';

interface GreetingService {
  message(): string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeting: GreetingService;
  }

  interface Events {
    'forge/spike'(message: string): void;
  }
}

export interface CordisSpikeResult {
  readonly greeting: string;
  readonly observedMessages: readonly string[];
  readonly cleanupOrder: readonly string[];
  readonly liveEffectsBeforeDispose: readonly string[];
  readonly serviceAfterDispose: GreetingService | undefined;
}

export async function runCordisLifecycleSpike(): Promise<CordisSpikeResult> {
  const root = new Context();
  const observedMessages: string[] = [];
  const cleanupOrder: string[] = [];

  const lifecyclePlugin: Plugin.Object<void> = {
    name: 'forge-cordis-lifecycle-spike',
    apply(ctx) {
      ctx.provide('greeting', {
        message: () => 'hello from a scoped Cordis service',
      });
      ctx.on('forge/spike', (message) => observedMessages.push(message));
      ctx.effect(() => () => cleanupOrder.push('first'), 'forge-spike:first');
      ctx.effect(() => () => cleanupOrder.push('second'), 'forge-spike:second');
    },
  };

  const fiber = await root.plugin(lifecyclePlugin);
  root.emit('forge/spike', 'plugin-active');

  const greeting = root.greeting.message();
  const liveEffectsBeforeDispose = fiber.getEffects().map((effect) => effect.label);
  await fiber.dispose();

  root.emit('forge/spike', 'plugin-disposed');

  return {
    greeting,
    observedMessages,
    cleanupOrder,
    liveEffectsBeforeDispose,
    serviceAfterDispose: root.get('greeting'),
  };
}
