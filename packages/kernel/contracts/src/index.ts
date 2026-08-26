export const FORGE_API_VERSION = 'forge.dev/v1' as const;

export type ForgeApiVersion = typeof FORGE_API_VERSION;
export type PluginRuntime = 'trusted' | 'process';
export type PluginName = string & { readonly __brand: 'PluginName' };
export type ServiceId = string & { readonly __brand: 'ServiceId' };
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

export interface ServiceToken<T> {
  readonly id: ServiceId;
  readonly cardinality: 'exclusive' | 'multiple';
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

export interface ForgeContext {
  provide<T>(token: ServiceToken<T>, value: T): ForgeDisposable;
  get<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
  effect(dispose: () => void | Promise<void>): void;
  scope(options: ScopeOptions): ForgeContext;
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

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function brandedIdentifier<T extends string>(kind: string, value: string): T {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ForgeError('INVALID_MANIFEST', `${kind} must use lower-case hyphen-case`, {
      value,
    });
  }
  return value as T;
}

export function pluginName(value: string): PluginName {
  return brandedIdentifier<PluginName>('plugin name', value);
}

export function serviceId(value: string): ServiceId {
  return brandedIdentifier<ServiceId>('service id', value);
}

export function serviceToken<T>(
  id: string,
  cardinality: ServiceToken<T>['cardinality'] = 'exclusive',
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
