export const FORGE_API_VERSION = 'forge.dev/v1' as const;

export type ForgeApiVersion = typeof FORGE_API_VERSION;
export type PluginRuntime = 'trusted' | 'process';
export type ServiceCardinality = 'exclusive' | 'multiple';
export type PluginName = string & { readonly __brand: 'PluginName' };
export type ServiceId = string & { readonly __brand: 'ServiceId' };
export type ScopeId = string & { readonly __brand: 'ScopeId' };
export type ThreadId = string & { readonly __brand: 'ThreadId' };
export type TurnId = string & { readonly __brand: 'TurnId' };
export type ItemId = string & { readonly __brand: 'ItemId' };

export interface ForgeDisposable {
  dispose(): void | Promise<void>;
}

export interface ForgeCancellation {
  readonly signal: AbortSignal;
  throwIfCancelled(): void;
}

export interface ServiceToken<T, Cardinality extends ServiceCardinality = ServiceCardinality> {
  readonly id: ServiceId;
  readonly cardinality: Cardinality;
  readonly _serviceType?: T;
}

export interface PluginPermissions {
  readonly filesystem?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly network?: readonly string[];
  readonly secrets?: readonly string[];
  readonly subprocess?: boolean;
}

export interface PluginManifest {
  readonly apiVersion: ForgeApiVersion;
  readonly name: PluginName;
  readonly version: string;
  readonly runtime: PluginRuntime;
  readonly entrypoint: string;
  readonly requires?: Readonly<Record<string, string>>;
  readonly optional?: Readonly<Record<string, string>>;
  readonly provides?: readonly string[];
  readonly contributes?: Readonly<Record<string, readonly string[]>>;
  readonly permissions?: PluginPermissions;
}

export interface ScopeOptions {
  readonly name: string;
  readonly parentPlugin?: PluginName;
}

export interface ServiceScopeInspection {
  readonly id: ScopeId;
  readonly name: string;
  readonly parentId: ScopeId | undefined;
  readonly parentPlugin: PluginName | undefined;
}

export interface ServiceProviderInspection {
  readonly registrationId: string;
  readonly scopeId: ScopeId;
}

export interface ServiceInspection {
  readonly id: ServiceId;
  readonly cardinality: ServiceCardinality;
  readonly providers: readonly ServiceProviderInspection[];
}

export interface ServiceGraphInspection {
  readonly rootScopeId: ScopeId;
  readonly scopes: readonly ServiceScopeInspection[];
  readonly services: readonly ServiceInspection[];
}

export interface ForgeContext extends ForgeDisposable {
  readonly id: ScopeId;
  readonly name: string;
  readonly disposed: boolean;
  provide<T, Cardinality extends ServiceCardinality>(
    token: ServiceToken<T, Cardinality>,
    value: T,
  ): ForgeDisposable;
  get<T>(token: ServiceToken<T, 'exclusive'>): T;
  get<T>(token: ServiceToken<T, 'multiple'>): readonly T[];
  optional<T>(token: ServiceToken<T, 'exclusive'>): T | undefined;
  optional<T>(token: ServiceToken<T, 'multiple'>): readonly T[];
  effect(dispose: () => void | Promise<void>): void;
  scope(options: ScopeOptions): ForgeContext;
  inspectServices(): ServiceGraphInspection;
}

export interface ForgePlugin {
  readonly manifest: PluginManifest;
  setup(context: ForgeContext): void | Promise<void>;
}

export type ForgeErrorCode =
  | 'CANCELLED'
  | 'INVALID_MANIFEST'
  | 'INCOMPATIBLE_API'
  | 'MISSING_SERVICE'
  | 'SERVICE_CONFLICT'
  | 'DEPENDENCY_CYCLE'
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_DISPOSE_FAILED'
  | 'CONTEXT_DISPOSED'
  | 'CONTEXT_DISPOSE_FAILED'
  | 'INVARIANT_VIOLATION';

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ForgeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ForgeError';
    this.code = code;
    this.details = details;
  }
}

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVICE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function brandedIdentifier<T extends string>(
  kind: string,
  value: string,
  pattern: RegExp,
  expected: string,
): T {
  if (!pattern.test(value)) {
    throw new ForgeError('INVALID_MANIFEST', `${kind} must use ${expected}`, { value });
  }
  return value as T;
}

export function pluginName(value: string): PluginName {
  return brandedIdentifier<PluginName>(
    'plugin name',
    value,
    PLUGIN_NAME_PATTERN,
    'lower-case hyphen-case',
  );
}

export function serviceId(value: string): ServiceId {
  return brandedIdentifier<ServiceId>(
    'service id',
    value,
    SERVICE_ID_PATTERN,
    'lower-case dot/hyphen-separated segments',
  );
}

export function serviceToken<T>(id: string): ServiceToken<T, 'exclusive'>;
export function serviceToken<T>(id: string, cardinality: 'exclusive'): ServiceToken<T, 'exclusive'>;
export function serviceToken<T>(id: string, cardinality: 'multiple'): ServiceToken<T, 'multiple'>;
export function serviceToken<T>(
  id: string,
  cardinality: ServiceCardinality = 'exclusive',
): ServiceToken<T> {
  return Object.freeze({ id: serviceId(id), cardinality });
}

export function cancellation(signal: AbortSignal): ForgeCancellation {
  return Object.freeze({
    signal,
    throwIfCancelled(): void {
      if (signal.aborted) {
        throw new ForgeError('CANCELLED', 'Operation was cancelled', undefined, {
          cause: signal.reason,
        });
      }
    },
  });
}
