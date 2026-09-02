import { Context as CordisContext } from '@deepseek-ai/cordis';
import {
  ForgeError,
  cancellation as createCancellation,
  type BroadcastEventListener,
  type BroadcastEventToken,
  type DecisionEventListener,
  type DecisionEventToken,
  type EventGraphInspection,
  type EventId,
  type EventInspection,
  type EventKind,
  type EventListenerOptions,
  type ForgeCancellation,
  type ForgeContext,
  type ForgeDecision,
  type ForgeDisposable,
  type PluginName,
  type ResolvedForgeDecision,
  type ScopeId,
  type ScopeOptions,
  type SerialEventListener,
  type SerialEventToken,
  type ServiceCardinality,
  type ServiceGraphInspection,
  type ServiceId,
  type ServiceInspection,
  type ServiceToken,
  type WaterfallEventListener,
  type WaterfallEventToken,
} from '@forge/kernel-contracts';

interface OwnedRegistration {
  readonly id: string;
  active: boolean;
  dispose(): Promise<void>;
}

interface ServiceBinding<T = unknown> extends OwnedRegistration {
  readonly tokenId: ServiceId;
  readonly cardinality: ServiceCardinality;
  readonly value: T;
  readonly scopeId: ScopeId;
}

interface EventBinding extends OwnedRegistration {
  readonly eventId: EventId;
  readonly kind: EventKind;
  readonly scopeId: ScopeId;
}

interface CordisEventBridge {
  on(
    name: string,
    listener: (...args: unknown[]) => unknown,
    options?: { readonly prepend?: boolean; readonly global?: boolean },
  ): () => boolean;
  parallel(name: string, ...args: unknown[]): Promise<void>;
  serial(name: string, ...args: unknown[]): Promise<unknown>;
  waterfall(name: string, ...args: unknown[]): unknown;
}

interface SerialResultEnvelope<Result> {
  readonly value: Result;
}

interface SharedContextState {
  readonly scopes: Map<ScopeId, CordisForgeContext>;
  readonly cardinalities: Map<ServiceId, ServiceCardinality>;
  readonly eventKinds: Map<EventId, EventKind>;
  readonly events: Map<EventId, EventBinding[]>;
  nextScopeSequence: number;
  nextRegistrationSequence: number;
  rootScopeId: ScopeId;
}

interface ContextConstructionOptions extends ScopeOptions {
  readonly parent: CordisForgeContext | undefined;
  readonly serviceTarget?: CordisForgeContext;
}

function scopeId(sequence: number): ScopeId {
  return `scope-${sequence}` as ScopeId;
}

function freezeList<T extends object>(values: T[]): readonly Readonly<T>[] {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

const NEVER_CANCELLED = createCancellation(new AbortController().signal);

const DECISION_RANK: Readonly<Record<ResolvedForgeDecision, number>> = Object.freeze({
  allow: 0,
  ask: 1,
  deny: 2,
});

function eventName(id: EventId): string {
  return `forge/${id}`;
}

function strictestDecision(
  left: ResolvedForgeDecision,
  right: ResolvedForgeDecision,
): ResolvedForgeDecision {
  return DECISION_RANK[left] >= DECISION_RANK[right] ? left : right;
}

function assertResolvedDecision(value: unknown): asserts value is ResolvedForgeDecision {
  if (value !== 'allow' && value !== 'ask' && value !== 'deny') {
    throw new ForgeError('INVARIANT_VIOLATION', 'Decision terminal returned an invalid result', {
      value,
    });
  }
}

function assertDecision(value: unknown): asserts value is ForgeDecision {
  if (value !== 'allow' && value !== 'ask' && value !== 'deny' && value !== 'delegate') {
    throw new ForgeError('INVARIANT_VIOLATION', 'Decision listener returned an invalid result', {
      value,
    });
  }
}

export class CordisForgeContext implements ForgeContext {
  readonly id: ScopeId;
  readonly name: string;

  readonly #cordis: CordisContext;
  readonly #parent: CordisForgeContext | undefined;
  readonly #parentPlugin: PluginName | undefined;
  readonly #shared: SharedContextState;
  readonly #serviceTarget: CordisForgeContext;
  readonly #children: CordisForgeContext[] = [];
  readonly #bindings = new Map<ServiceId, ServiceBinding[]>();
  readonly #owned: OwnedRegistration[] = [];

  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(
    cordis: CordisContext,
    shared: SharedContextState,
    options: ContextConstructionOptions,
  ) {
    const normalizedName = options.name.trim();
    if (normalizedName.length === 0) {
      throw new ForgeError('INVARIANT_VIOLATION', 'Context scope name cannot be empty');
    }

    this.#cordis = cordis;
    this.#shared = shared;
    this.#parent = options.parent;
    this.#parentPlugin = options.parentPlugin;
    this.#serviceTarget = options.serviceTarget ?? this;
    this.name = normalizedName;
    this.id = scopeId(shared.nextScopeSequence++);

    shared.scopes.set(this.id, this);
    if (options.parent) options.parent.#children.push(this);
  }

  static createRoot(name = 'root'): CordisForgeContext {
    const shared: SharedContextState = {
      scopes: new Map(),
      cardinalities: new Map(),
      eventKinds: new Map(),
      events: new Map(),
      nextScopeSequence: 1,
      nextRegistrationSequence: 1,
      rootScopeId: '' as ScopeId,
    };
    const root = new CordisForgeContext(new CordisContext(), shared, {
      name,
      parent: undefined,
    });
    shared.rootScopeId = root.id;
    return root;
  }

  static createPluginScope(parent: CordisForgeContext, options: ScopeOptions): CordisForgeContext {
    parent.#assertActive();
    const root = parent.#shared.scopes.get(parent.#shared.rootScopeId);
    if (!root) {
      throw new ForgeError('INVARIANT_VIOLATION', 'Forge root context is not available');
    }
    return new CordisForgeContext(parent.#cordis.extend({}), parent.#shared, {
      ...options,
      parent,
      serviceTarget: root,
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  provide<T, Cardinality extends ServiceCardinality>(
    token: ServiceToken<T, Cardinality>,
    value: T,
  ): ForgeDisposable {
    this.#assertActive();
    this.#assertTokenCardinality(token);

    const current = this.#serviceTarget.#activeBindings(token.id);
    if (token.cardinality === 'exclusive' && current.length > 0) {
      throw new ForgeError(
        'SERVICE_CONFLICT',
        `Exclusive service ${token.id} already has a provider in scope ${this.name}`,
        { serviceId: token.id, scopeId: this.id },
      );
    }

    const registrationId = `registration-${this.#shared.nextRegistrationSequence++}`;
    const cordisName = `forge.internal.${this.id}.${registrationId}.${token.id}`;
    const disposeCordis = this.#cordis.provide(cordisName, value);

    const binding: ServiceBinding<T> = {
      id: registrationId,
      tokenId: token.id,
      cardinality: token.cardinality,
      value,
      scopeId: this.id,
      active: true,
      dispose: async () => {
        if (!binding.active) return;
        binding.active = false;
        this.#serviceTarget.#removeBinding(binding);
        await disposeCordis();
      },
    };

    const bindings = this.#serviceTarget.#bindings.get(token.id) ?? [];
    bindings.push(binding as ServiceBinding);
    this.#serviceTarget.#bindings.set(token.id, bindings);
    this.#owned.push(binding);

    return Object.freeze({ dispose: binding.dispose });
  }

  get<T>(token: ServiceToken<T, 'exclusive'>): T;
  get<T>(token: ServiceToken<T, 'multiple'>): readonly T[];
  get<T>(token: ServiceToken<T, ServiceCardinality>): T | readonly T[] {
    this.#assertActive();
    this.#checkKnownCardinality(token);

    if (token.cardinality === 'multiple') {
      const values = this.#resolveMultiple<T>(token.id);
      if (values.length === 0) this.#throwMissing(token.id);
      return values;
    }

    const binding = this.#resolveExclusive<T>(token.id);
    if (!binding) this.#throwMissing(token.id);
    return binding.value;
  }

  optional<T>(token: ServiceToken<T, 'exclusive'>): T | undefined;
  optional<T>(token: ServiceToken<T, 'multiple'>): readonly T[];
  optional<T>(token: ServiceToken<T, ServiceCardinality>): T | readonly T[] | undefined {
    this.#assertActive();
    this.#checkKnownCardinality(token);

    if (token.cardinality === 'multiple') {
      return this.#resolveMultiple<T>(token.id);
    }

    return this.#resolveExclusive<T>(token.id)?.value;
  }

  on<Payload>(
    event: BroadcastEventToken<Payload>,
    listener: BroadcastEventListener<Payload>,
    options?: EventListenerOptions,
  ): ForgeDisposable;
  on<Payload, Result>(
    event: SerialEventToken<Payload, Result>,
    listener: SerialEventListener<Payload, Result>,
    options?: EventListenerOptions,
  ): ForgeDisposable;
  on<Payload, Result>(
    event: WaterfallEventToken<Payload, Result>,
    listener: WaterfallEventListener<Payload, Result>,
    options?: EventListenerOptions,
  ): ForgeDisposable;
  on<Payload>(
    event: DecisionEventToken<Payload>,
    listener: DecisionEventListener<Payload>,
    options?: EventListenerOptions,
  ): ForgeDisposable;
  on(
    event:
      | BroadcastEventToken<unknown>
      | SerialEventToken<unknown, unknown>
      | WaterfallEventToken<unknown, unknown>
      | DecisionEventToken<unknown>,
    listener: unknown,
    options: EventListenerOptions = {},
  ): ForgeDisposable {
    this.#assertActive();
    this.#assertEventKind(event.id, event.kind);
    if (typeof listener !== 'function') {
      throw new ForgeError('INVARIANT_VIOLATION', `Listener for ${event.id} must be a function`);
    }

    const adapter = this.#createEventAdapter(event.kind, listener);
    const cordisOptions = options.prepend ? { prepend: true, global: true } : { global: true };
    const disposeCordis = this.#events.on(eventName(event.id), adapter, cordisOptions);
    const registrationId = `registration-${this.#shared.nextRegistrationSequence++}`;

    const binding: EventBinding = {
      id: registrationId,
      eventId: event.id,
      kind: event.kind,
      scopeId: this.id,
      active: true,
      dispose: async () => {
        if (!binding.active) return;
        binding.active = false;
        this.#removeEventBinding(binding);
        disposeCordis();
      },
    };

    const bindings = this.#shared.events.get(event.id) ?? [];
    if (options.prepend) bindings.unshift(binding);
    else bindings.push(binding);
    this.#shared.events.set(event.id, bindings);
    this.#owned.push(binding);
    return Object.freeze({ dispose: binding.dispose });
  }

  async broadcast<Payload>(
    event: BroadcastEventToken<Payload>,
    payload: Payload,
    cancellation: ForgeCancellation = NEVER_CANCELLED,
  ): Promise<void> {
    this.#assertActive();
    this.#assertEventKind(event.id, event.kind);
    cancellation.throwIfCancelled();
    await this.#events.parallel(eventName(event.id), payload, cancellation);
    cancellation.throwIfCancelled();
  }

  async serial<Payload, Result>(
    event: SerialEventToken<Payload, Result>,
    payload: Payload,
    cancellation: ForgeCancellation = NEVER_CANCELLED,
  ): Promise<Result | undefined> {
    this.#assertActive();
    this.#assertEventKind(event.id, event.kind);
    cancellation.throwIfCancelled();
    const envelope = (await this.#events.serial(eventName(event.id), payload, cancellation)) as
      | SerialResultEnvelope<Result>
      | undefined;
    cancellation.throwIfCancelled();
    return envelope?.value;
  }

  async waterfall<Payload, Result>(
    event: WaterfallEventToken<Payload, Result>,
    payload: Payload,
    terminal: (payload: Payload, cancellation: ForgeCancellation) => Result | Promise<Result>,
    cancellation: ForgeCancellation = NEVER_CANCELLED,
  ): Promise<Result> {
    this.#assertActive();
    this.#assertEventKind(event.id, event.kind);
    cancellation.throwIfCancelled();
    const result = await this.#events.waterfall(
      eventName(event.id),
      payload,
      cancellation,
      async () => {
        cancellation.throwIfCancelled();
        const value = await terminal(payload, cancellation);
        cancellation.throwIfCancelled();
        return value;
      },
    );
    cancellation.throwIfCancelled();
    return result as Result;
  }

  async decide<Payload>(
    event: DecisionEventToken<Payload>,
    payload: Payload,
    terminal: (
      payload: Payload,
      cancellation: ForgeCancellation,
    ) => ResolvedForgeDecision | Promise<ResolvedForgeDecision>,
    cancellation: ForgeCancellation = NEVER_CANCELLED,
  ): Promise<ResolvedForgeDecision> {
    this.#assertActive();
    this.#assertEventKind(event.id, event.kind);
    cancellation.throwIfCancelled();
    const result = await this.#events.waterfall(
      eventName(event.id),
      payload,
      cancellation,
      async () => {
        cancellation.throwIfCancelled();
        const decision = await terminal(payload, cancellation);
        assertResolvedDecision(decision);
        cancellation.throwIfCancelled();
        return decision;
      },
    );
    assertResolvedDecision(result);
    cancellation.throwIfCancelled();
    return result;
  }

  effect(dispose: () => void | Promise<void>): void {
    this.#assertActive();
    const registrationId = `registration-${this.#shared.nextRegistrationSequence++}`;
    const disposeCordis = this.#cordis.effect(
      () => dispose,
      `forge-context:${this.id}:${registrationId}`,
    );

    const registration: OwnedRegistration = {
      id: registrationId,
      active: true,
      dispose: async () => {
        if (!registration.active) return;
        registration.active = false;
        await disposeCordis();
      },
    };
    this.#owned.push(registration);
  }

  scope(options: ScopeOptions): ForgeContext {
    this.#assertActive();
    return new CordisForgeContext(this.#cordis.extend({}), this.#shared, {
      ...options,
      parent: this,
    });
  }

  inspectServices(): ServiceGraphInspection {
    this.#assertActive();

    const scopes = [...this.#shared.scopes.values()]
      .filter((scope) => !scope.disposed)
      .map((scope) => ({
        id: scope.id,
        name: scope.name,
        parentId: scope.#parent?.id,
        parentPlugin: scope.#parentPlugin,
      }));

    const services = new Map<ServiceId, ServiceInspection>();
    for (const scope of this.#shared.scopes.values()) {
      if (scope.disposed) continue;
      for (const [id, bindings] of scope.#bindings) {
        for (const binding of bindings) {
          if (!binding.active) continue;
          const current = services.get(id);
          const provider = Object.freeze({
            registrationId: binding.id,
            scopeId: binding.scopeId,
          });
          if (current) {
            services.set(
              id,
              Object.freeze({
                ...current,
                providers: Object.freeze([...current.providers, provider]),
              }),
            );
          } else {
            services.set(
              id,
              Object.freeze({
                id,
                cardinality: binding.cardinality,
                providers: Object.freeze([provider]),
              }),
            );
          }
        }
      }
    }

    return Object.freeze({
      rootScopeId: this.#shared.rootScopeId,
      scopes: freezeList(scopes),
      services: Object.freeze([...services.values()]),
    });
  }

  inspectEvents(): EventGraphInspection {
    this.#assertActive();
    const events: EventInspection[] = [];
    for (const [id, bindings] of this.#shared.events) {
      const active = bindings.filter((binding) => binding.active);
      if (active.length === 0) continue;
      events.push(
        Object.freeze({
          id,
          kind: active[0]?.kind ?? this.#shared.eventKinds.get(id) ?? 'broadcast',
          listeners: Object.freeze(
            active.map((binding) =>
              Object.freeze({ registrationId: binding.id, scopeId: binding.scopeId }),
            ),
          ),
        }),
      );
    }
    return Object.freeze({ events: Object.freeze(events) });
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#disposePromise = this.#disposeInternal();
    }
    return this.#disposePromise;
  }

  async #disposeInternal(): Promise<void> {
    this.#disposed = true;
    const errors: unknown[] = [];

    for (const child of [...this.#children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const registration of [...this.#owned].reverse()) {
      try {
        await registration.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    if (this.#parent) this.#parent.#removeChild(this);
    this.#shared.scopes.delete(this.id);

    if (errors.length > 0) {
      throw new ForgeError(
        'CONTEXT_DISPOSE_FAILED',
        `Context ${this.name} failed to dispose cleanly`,
        { scopeId: this.id, errorCount: errors.length },
        { cause: new AggregateError(errors) },
      );
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ForgeError('CONTEXT_DISPOSED', `Context ${this.name} has been disposed`, {
        scopeId: this.id,
      });
    }
  }

  #assertTokenCardinality<T>(token: ServiceToken<T, ServiceCardinality>): void {
    const known = this.#shared.cardinalities.get(token.id);
    if (known && known !== token.cardinality) {
      throw new ForgeError(
        'SERVICE_CONFLICT',
        `Service ${token.id} is already declared as ${known}`,
        { serviceId: token.id, expected: known, received: token.cardinality },
      );
    }
    this.#shared.cardinalities.set(token.id, token.cardinality);
  }

  #checkKnownCardinality<T>(token: ServiceToken<T, ServiceCardinality>): void {
    const known = this.#shared.cardinalities.get(token.id);
    if (known && known !== token.cardinality) {
      throw new ForgeError(
        'SERVICE_CONFLICT',
        `Service ${token.id} is registered as ${known}, not ${token.cardinality}`,
        { serviceId: token.id, expected: known, received: token.cardinality },
      );
    }
  }

  #assertEventKind(id: EventId, kind: EventKind): void {
    const known = this.#shared.eventKinds.get(id);
    if (known && known !== kind) {
      throw new ForgeError('EVENT_CONFLICT', `Event ${id} is already declared as ${known}`, {
        eventId: id,
        expected: known,
        received: kind,
      });
    }
    this.#shared.eventKinds.set(id, kind);
  }

  #createEventAdapter(kind: EventKind, listener: unknown): (...args: unknown[]) => unknown {
    if (kind === 'broadcast') {
      const typed = listener as BroadcastEventListener<unknown>;
      return async (payload, cancellation) => {
        const token = cancellation as ForgeCancellation;
        token.throwIfCancelled();
        await typed(payload, token);
        token.throwIfCancelled();
      };
    }

    if (kind === 'serial') {
      const typed = listener as SerialEventListener<unknown, unknown>;
      return async (payload, cancellation) => {
        const token = cancellation as ForgeCancellation;
        token.throwIfCancelled();
        const value = await typed(payload, token);
        token.throwIfCancelled();
        return value === undefined ? undefined : Object.freeze({ value });
      };
    }

    if (kind === 'waterfall') {
      const typed = listener as WaterfallEventListener<unknown, unknown>;
      return async (payload, cancellation, next) => {
        const token = cancellation as ForgeCancellation;
        token.throwIfCancelled();
        const guardedNext = this.#singleUseNext(next as () => unknown, token);
        const value = await typed(payload, guardedNext, token);
        token.throwIfCancelled();
        return value;
      };
    }

    const typed = listener as DecisionEventListener<unknown>;
    return async (payload, cancellation, next) => {
      const token = cancellation as ForgeCancellation;
      token.throwIfCancelled();
      const guardedNext = this.#singleUseNext<ResolvedForgeDecision>(next as () => unknown, token);
      let downstream: Promise<ResolvedForgeDecision> | undefined;
      const trackedNext = (): Promise<ResolvedForgeDecision> => {
        downstream = guardedNext();
        return downstream;
      };
      const ownDecision = await typed(payload, trackedNext, token);
      assertDecision(ownDecision);
      token.throwIfCancelled();

      if (ownDecision === 'deny' && !downstream) return 'deny';
      const delegated = downstream ?? trackedNext();
      const downstreamDecision = await delegated;
      assertResolvedDecision(downstreamDecision);
      token.throwIfCancelled();
      return ownDecision === 'delegate'
        ? downstreamDecision
        : strictestDecision(ownDecision, downstreamDecision);
    };
  }

  #singleUseNext<Result>(
    next: () => unknown,
    cancellation: ForgeCancellation,
  ): () => Promise<Result> {
    let called = false;
    return async () => {
      if (called) {
        throw new ForgeError(
          'EVENT_NEXT_CALLED_MULTIPLE',
          'A waterfall listener may call next() only once',
        );
      }
      called = true;
      cancellation.throwIfCancelled();
      const result = (await next()) as Result;
      cancellation.throwIfCancelled();
      return result;
    };
  }

  #activeBindings(id: ServiceId): ServiceBinding[] {
    return (this.#bindings.get(id) ?? []).filter((binding) => binding.active);
  }

  #resolveExclusive<T>(id: ServiceId): ServiceBinding<T> | undefined {
    let scope: CordisForgeContext | undefined = this;
    while (scope) {
      const binding = scope.#activeBindings(id)[0] as ServiceBinding<T> | undefined;
      if (binding) return binding;
      scope = scope.#parent;
    }
    return undefined;
  }

  #resolveMultiple<T>(id: ServiceId): readonly T[] {
    const lineage: CordisForgeContext[] = [];
    let scope: CordisForgeContext | undefined = this;
    while (scope) {
      lineage.unshift(scope);
      scope = scope.#parent;
    }

    const values = lineage.flatMap((item) =>
      item.#activeBindings(id).map((binding) => binding.value as T),
    );
    return Object.freeze(values);
  }

  #removeBinding(binding: ServiceBinding): void {
    const bindings = this.#bindings.get(binding.tokenId);
    if (!bindings) return;
    const index = bindings.indexOf(binding);
    if (index >= 0) bindings.splice(index, 1);
    if (bindings.length === 0) this.#bindings.delete(binding.tokenId);
  }

  #removeEventBinding(binding: EventBinding): void {
    const bindings = this.#shared.events.get(binding.eventId);
    if (!bindings) return;
    const index = bindings.indexOf(binding);
    if (index >= 0) bindings.splice(index, 1);
    if (bindings.length === 0) this.#shared.events.delete(binding.eventId);
  }

  get #events(): CordisEventBridge {
    return this.#cordis.events as unknown as CordisEventBridge;
  }

  #removeChild(child: CordisForgeContext): void {
    const index = this.#children.indexOf(child);
    if (index >= 0) this.#children.splice(index, 1);
  }

  #throwMissing(id: ServiceId): never {
    throw new ForgeError('MISSING_SERVICE', `Service ${id} is not available`, {
      serviceId: id,
      scopeId: this.id,
    });
  }
}

export function createForgeContext(name = 'root'): ForgeContext {
  return CordisForgeContext.createRoot(name);
}

export function createPluginContext(parent: ForgeContext, options: ScopeOptions): ForgeContext {
  if (!(parent instanceof CordisForgeContext)) {
    throw new ForgeError(
      'INVARIANT_VIOLATION',
      'Plugin contexts require a Cordis-backed Forge context',
    );
  }
  return CordisForgeContext.createPluginScope(parent, options);
}
