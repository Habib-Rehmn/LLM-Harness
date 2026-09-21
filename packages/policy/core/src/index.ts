import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import type {
  GuardedToolCall,
  ToolGuard,
  ToolOrigin,
  ToolPolicyDecision,
  ToolPolicyMatch,
  ToolRisk,
} from '@forge/tools-core';

export type PolicyEffect = 'allow' | 'ask' | 'deny';
export type FileAccess = 'read' | 'write';

export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  readonly effect: PolicyEffect;
  readonly tools?: readonly string[];
  readonly modes?: readonly string[];
  readonly risks?: readonly ToolRisk[];
  readonly origins?: readonly ToolOrigin[];
  readonly readOnly?: boolean;
  readonly capabilities?: readonly string[];
  readonly paths?: {
    readonly access?: FileAccess;
    readonly patterns: readonly string[];
  };
  readonly commands?: {
    readonly executables?: readonly string[];
    readonly shellPatterns?: readonly string[];
  };
  readonly network?: {
    readonly hosts: readonly string[];
  };
  readonly externalSideEffect?: boolean;
}

export interface PolicySet {
  readonly id: string;
  readonly rules: readonly PolicyRule[];
  readonly defaultEffect: PolicyEffect;
  readonly defaultDescription: string;
}

export interface ApprovalGrantInput {
  readonly scope: 'session' | 'workspace';
  readonly scopeId: string;
  readonly ruleId: string;
  readonly tool: string;
  readonly expiresAt?: string;
}

export interface ApprovalGrant extends ApprovalGrantInput {
  readonly id: string;
  readonly createdAt: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly ruleId: string;
  readonly tool: string;
  readonly reason: string;
  readonly sessionId?: string;
  readonly workspaceId: string;
  readonly createdAt: string;
}

export class ApprovalBroker {
  readonly #requests = new Map<string, ApprovalRequest>();
  readonly #grants = new Map<string, ApprovalGrant>();

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest {
    const request = Object.freeze({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    this.#requests.set(request.id, request);
    return request;
  }

  grant(input: ApprovalGrantInput): ApprovalGrant {
    if (!input.scopeId || !input.ruleId || !input.tool)
      throw new Error('Approval grant is incomplete');
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error('Approval expiration is invalid');
    }
    const grant = Object.freeze({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    this.#grants.set(grant.id, grant);
    return grant;
  }

  revoke(id: string): void {
    this.#grants.delete(id);
  }

  listRequests(): readonly ApprovalRequest[] {
    return Object.freeze([...this.#requests.values()]);
  }

  listGrants(): readonly ApprovalGrant[] {
    this.#purgeExpired();
    return Object.freeze([...this.#grants.values()]);
  }

  allows(call: GuardedToolCall, ruleId: string): ApprovalGrant | undefined {
    this.#purgeExpired();
    for (const grant of this.#grants.values()) {
      const scopeId =
        grant.scope === 'session' ? call.sessionId : (call.workspaceId ?? call.workspaceRoot);
      if (
        scopeId === grant.scopeId &&
        grant.ruleId === ruleId &&
        matchGlob(call.name, grant.tool)
      ) {
        return grant;
      }
    }
    return undefined;
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [id, grant] of this.#grants) {
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) this.#grants.delete(id);
    }
  }
}

interface CallResources {
  readonly paths: readonly string[];
  readonly access: FileAccess;
  readonly executable?: string;
  readonly shell?: string;
  readonly hosts: readonly string[];
  readonly externalSideEffect: boolean;
}

interface MatchedRule {
  readonly rule: PolicyRule;
  readonly match: ToolPolicyMatch;
}

export class ImmutablePolicyGuard implements ToolGuard {
  readonly #policy: PolicySet;
  readonly #approvals: ApprovalBroker;

  constructor(policy: PolicySet, approvals = new ApprovalBroker()) {
    validatePolicy(policy);
    this.#policy = deepFreeze(structuredClone(policy));
    this.#approvals = approvals;
    Object.freeze(this);
  }

  get policy(): PolicySet {
    return this.#policy;
  }

  get approvals(): ApprovalBroker {
    return this.#approvals;
  }

  async evaluate(call: GuardedToolCall, signal: AbortSignal): Promise<ToolPolicyDecision> {
    signal.throwIfAborted();
    if (call.name !== call.definition.name) {
      return decision(
        'deny',
        'forge.security.tool-identity-mismatch',
        'Tool call identity does not match its registered definition',
        { tool: call.name, definition: call.definition.name },
      );
    }
    let resources: CallResources;
    try {
      resources = await extractResources(call);
    } catch (error) {
      return decision('deny', 'forge.security.invalid-resource', 'Resource validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const matches = this.#policy.rules
      .map((rule) =>
        matchesRule(rule, call, resources) ? matched(rule, call, resources) : undefined,
      )
      .filter((value): value is MatchedRule => value !== undefined);
    const denied = matches.find(({ rule }) => rule.effect === 'deny');
    if (denied) return withReason('deny', denied);
    const asks = matches.filter(({ rule }) => rule.effect === 'ask');
    for (const ask of asks) {
      if (!this.#approvals.allows(call, ask.rule.id)) {
        const request = this.#approvals.request({
          ruleId: ask.rule.id,
          tool: call.name,
          reason: ask.rule.description,
          ...(call.sessionId ? { sessionId: call.sessionId } : {}),
          workspaceId: call.workspaceId ?? call.workspaceRoot,
        });
        return {
          decision: 'ask',
          reason: ask.rule.description,
          match: ask.match,
          approvalId: request.id,
        };
      }
    }
    if (asks.length > 0) {
      const approved = asks[0];
      if (!approved) throw new Error('Approved policy match disappeared');
      return {
        decision: 'allow',
        match: {
          ...approved.match,
          evidence: { ...approved.match.evidence, approved: true },
        },
      };
    }
    const allowed = matches.find(({ rule }) => rule.effect === 'allow');
    if (allowed) return { decision: 'allow', match: allowed.match };
    const defaultRuleId = `${this.#policy.id}.default`;
    if (this.#policy.defaultEffect === 'ask') {
      const match = policyMatch(defaultRuleId, this.#policy.defaultDescription, {
        tool: call.name,
      });
      if (this.#approvals.allows(call, defaultRuleId)) {
        return {
          decision: 'allow',
          match: { ...match, evidence: { ...match.evidence, approved: true } },
        };
      }
      const request = this.#approvals.request({
        ruleId: defaultRuleId,
        tool: call.name,
        reason: this.#policy.defaultDescription,
        ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        workspaceId: call.workspaceId ?? call.workspaceRoot,
      });
      return {
        decision: 'ask',
        reason: this.#policy.defaultDescription,
        match,
        approvalId: request.id,
      };
    }
    return decision(this.#policy.defaultEffect, defaultRuleId, this.#policy.defaultDescription, {
      tool: call.name,
    });
  }
}

function withReason(effect: 'deny', match: MatchedRule): ToolPolicyDecision {
  return { decision: effect, reason: match.rule.description, match: match.match };
}

function decision(
  effect: PolicyEffect,
  ruleId: string,
  description: string,
  evidence: ToolPolicyMatch['evidence'],
): ToolPolicyDecision {
  const match = policyMatch(ruleId, description, evidence);
  return effect === 'allow'
    ? { decision: effect, match }
    : { decision: effect, reason: description, match };
}

function policyMatch(
  ruleId: string,
  description: string,
  evidence: ToolPolicyMatch['evidence'],
): ToolPolicyMatch {
  return { ruleId, description, ...(evidence ? { evidence } : {}) };
}

function matched(rule: PolicyRule, call: GuardedToolCall, resources: CallResources): MatchedRule {
  return {
    rule,
    match: {
      ruleId: rule.id,
      description: rule.description,
      evidence: {
        tool: call.name,
        ...(resources.paths.length ? { paths: resources.paths } : {}),
        ...(resources.executable ? { executable: resources.executable } : {}),
        ...(resources.shell ? { shell: resources.shell } : {}),
        ...(resources.hosts.length ? { hosts: resources.hosts } : {}),
        externalSideEffect: resources.externalSideEffect,
      },
    },
  };
}

function matchesRule(rule: PolicyRule, call: GuardedToolCall, resources: CallResources): boolean {
  if (rule.tools && !rule.tools.some((pattern) => matchGlob(call.name, pattern))) return false;
  if (rule.modes && !rule.modes.includes(call.mode)) return false;
  if (rule.risks && !rule.risks.includes(call.definition.risk)) return false;
  if (rule.origins && !rule.origins.includes(call.definition.origin)) return false;
  if (rule.readOnly !== undefined && rule.readOnly !== call.definition.readOnly) return false;
  if (
    rule.capabilities &&
    !rule.capabilities.some((pattern) =>
      call.definition.capabilities.some((capability) => matchGlob(capability, pattern)),
    )
  )
    return false;
  if (
    rule.externalSideEffect !== undefined &&
    rule.externalSideEffect !== resources.externalSideEffect
  )
    return false;
  if (rule.paths) {
    if (rule.paths.access && rule.paths.access !== resources.access) return false;
    if (
      resources.paths.length === 0 ||
      !resources.paths.some((path) =>
        rule.paths?.patterns.some((pattern) => matchGlob(path, pattern)),
      )
    )
      return false;
  }
  if (rule.commands) {
    const executableMatch =
      resources.executable &&
      rule.commands.executables?.some((pattern) => matchGlob(resources.executable ?? '', pattern));
    const shellMatch =
      resources.shell &&
      rule.commands.shellPatterns?.some((pattern) => matchGlob(resources.shell ?? '', pattern));
    if (!executableMatch && !shellMatch) return false;
  }
  if (
    rule.network &&
    (resources.hosts.length === 0 ||
      !resources.hosts.some((host) =>
        rule.network?.hosts.some((pattern) => matchGlob(host, pattern)),
      ))
  )
    return false;
  return true;
}

async function extractResources(call: GuardedToolCall): Promise<CallResources> {
  const paths = await extractPaths(call.arguments, call.workspaceRoot);
  const argv = Array.isArray(call.arguments.argv) ? call.arguments.argv : undefined;
  const executable = typeof argv?.[0] === 'string' ? argv[0] : undefined;
  const shell = typeof call.arguments.shell === 'string' ? call.arguments.shell : undefined;
  const hosts = extractUrls(call.arguments).map((url) => new URL(url).hostname.toLowerCase());
  return {
    paths,
    access: call.definition.readOnly ? 'read' : 'write',
    ...(executable ? { executable } : {}),
    ...(shell ? { shell } : {}),
    hosts,
    externalSideEffect:
      call.definition.capabilities.some((capability) =>
        ['external.side_effect', 'network.write'].includes(capability),
      ) ||
      (!call.definition.readOnly && hosts.length > 0),
  };
}

async function extractPaths(value: unknown, workspaceRoot: string): Promise<readonly string[]> {
  const candidates: string[] = [];
  visit(value, (key, current) => {
    if (typeof current === 'string' && ['path', 'cwd', 'file', 'directory'].includes(key)) {
      candidates.push(current);
    }
  });
  const normalized: string[] = [];
  for (const candidate of candidates)
    normalized.push(await canonicalWorkspacePath(workspaceRoot, candidate));
  return [...new Set(normalized)].sort();
}

function extractUrls(value: unknown): readonly string[] {
  const urls: string[] = [];
  visit(value, (key, current) => {
    if (typeof current !== 'string' || !['url', 'uri', 'endpoint'].includes(key)) return;
    const parsed = new URL(current);
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('Only HTTP(S) network URLs are allowed');
    if (parsed.username || parsed.password)
      throw new Error('Credentials in network URLs are forbidden');
    urls.push(parsed.href);
  });
  return urls;
}

function visit(value: unknown, callback: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, current] of Object.entries(value)) {
    callback(key, current);
    visit(current, callback);
  }
}

async function canonicalWorkspacePath(rootInput: string, input: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('Workspace path is invalid');
  const root = await realpath(resolve(rootInput));
  const candidate = resolve(root, input);
  assertInside(root, candidate);
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Symlink resource is forbidden: ${input}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return relative(root, candidate).split(sep).join('/') || '.';
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Resource escapes the workspace');
  }
}

function matchGlob(value: string, pattern: string): boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else source += '[^/]*';
    } else if (character === '?') source += '.';
    else source += character?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? '';
  }
  return new RegExp(`^${source}$`, 'i').test(value);
}

function validatePolicy(policy: PolicySet): void {
  if (!policy.id || !policy.defaultDescription)
    throw new Error('Policy identity and default are required');
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(rule.id) || ids.has(rule.id)) {
      throw new Error(`Invalid or duplicate policy rule id: ${rule.id}`);
    }
    if (!rule.description) throw new Error(`Policy rule ${rule.id} needs a description`);
    ids.add(rule.id);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const READ_ONLY_POLICY: PolicySet = deepFreeze({
  id: 'forge.read-only',
  defaultEffect: 'deny',
  defaultDescription: 'Read-only policy defaults to deny',
  rules: [
    {
      id: 'read-only.deny-mutation',
      description: 'State-changing tools are forbidden in read-only mode',
      effect: 'deny',
      readOnly: false,
    },
    {
      id: 'read-only.deny-external',
      description: 'External side effects are forbidden in read-only mode',
      effect: 'deny',
      externalSideEffect: true,
    },
    {
      id: 'read-only.allow-inspection',
      description: 'Read-only inspection inside the workspace is allowed',
      effect: 'allow',
      readOnly: true,
      externalSideEffect: false,
    },
  ],
});

export const WORKSPACE_POLICY: PolicySet = deepFreeze({
  id: 'forge.workspace',
  defaultEffect: 'deny',
  defaultDescription: 'Workspace policy defaults to deny',
  rules: [
    {
      id: 'workspace.deny-protected',
      description: 'Protected Forge and Git metadata cannot be changed',
      effect: 'deny',
      paths: { access: 'write', patterns: ['.git', '.git/**', '.forge', '.forge/**'] },
    },
    {
      id: 'workspace.ask-shell',
      description: 'Explicit shell syntax requires approval',
      effect: 'ask',
      commands: { shellPatterns: ['**'] },
    },
    {
      id: 'workspace.ask-external',
      description: 'External side effects require approval',
      effect: 'ask',
      externalSideEffect: true,
    },
    {
      id: 'workspace.ask-destructive',
      description: 'Destructive tools require approval',
      effect: 'ask',
      risks: ['destructive'],
    },
    {
      id: 'workspace.allow-local',
      description: 'Local workspace operations are allowed',
      effect: 'allow',
      externalSideEffect: false,
    },
  ],
});

export const POLICY_GUARD_SERVICE = serviceToken<ImmutablePolicyGuard>('forge.policy-guard');
export const APPROVAL_BROKER_SERVICE = serviceToken<ApprovalBroker>('forge.approval-broker');

export function createPolicyPlugin(policy: PolicySet): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName(`forge-policy-${policy.id.replaceAll('.', '-')}`),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [POLICY_GUARD_SERVICE.id, APPROVAL_BROKER_SERVICE.id],
      permissions: {},
    },
    setup(context) {
      const approvals = new ApprovalBroker();
      const guard = new ImmutablePolicyGuard(policy, approvals);
      context.provide(APPROVAL_BROKER_SERVICE, approvals);
      context.provide(POLICY_GUARD_SERVICE, guard);
    },
  };
}

export const createReadOnlyPolicyPlugin = () => createPolicyPlugin(READ_ONLY_POLICY);
export const createWorkspacePolicyPlugin = () => createPolicyPlugin(WORKSPACE_POLICY);
