import { Context as CordisContext } from '@deepseek-ai/cordis';
import {
  ForgeError,
  type ForgeContext,
  type ForgeDisposable,
  type PluginName,
  type ScopeId,
  type ScopeOptions,
  type ServiceCardinality,
  type ServiceGraphInspection,
  type ServiceId,
  type ServiceInspection,
  type ServiceToken,
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

interface SharedContextState {
  readonly scopes: Map<ScopeId, CordisForgeContext>;
  readonly cardinalities: Map<ServiceId, ServiceCardinality>;
  nextScopeSequence: number;
  nextRegistrationSequence: number;
  rootScopeId: ScopeId;
}

interface ContextConstructionOptions extends ScopeOptions {
  readonly parent: CordisForgeContext | undefined;
}

function scopeId(sequence: number): ScopeId {
  return `scope-${sequence}` as ScopeId;
}

function freezeList<T extends object>(values: T[]): readonly Readonly<T>[] {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

export class CordisForgeContext implements ForgeContext {
  readonly id: ScopeId;
  readonly name: string;

  readonly #cordis: CordisContext;
  readonly #parent: CordisForgeContext | undefined;
  readonly #parentPlugin: PluginName | undefined;
  readonly #shared: SharedContextState;
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
    this.name = normalizedName;
    this.id = scopeId(shared.nextScopeSequence++);

    shared.scopes.set(this.id, this);
    if (options.parent) options.parent.#children.push(this);
  }

  static createRoot(name = 'root'): CordisForgeContext {
    const shared: SharedContextState = {
      scopes: new Map(),
      cardinalities: new Map(),
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

  get disposed(): boolean {
    return this.#disposed;
  }

  provide<T, Cardinality extends ServiceCardinality>(
    token: ServiceToken<T, Cardinality>,
    value: T,
  ): ForgeDisposable {
    this.#assertActive();
    this.#assertTokenCardinality(token);

    const current = this.#activeBindings(token.id);
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
        this.#removeBinding(binding);
        await disposeCordis();
      },
    };

    const bindings = this.#bindings.get(token.id) ?? [];
    bindings.push(binding as ServiceBinding);
    this.#bindings.set(token.id, bindings);
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
