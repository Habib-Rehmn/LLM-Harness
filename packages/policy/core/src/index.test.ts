import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createForgeContext, createPluginContext } from '@forge/kernel-context';
import type { GuardedToolCall, ToolDefinition } from '@forge/tools-core';
import {
  ApprovalBroker,
  ImmutablePolicyGuard,
  READ_ONLY_POLICY,
  WORKSPACE_POLICY,
  createReadOnlyPolicyPlugin,
  createWorkspacePolicyPlugin,
  type PolicyRule,
  type PolicySet,
} from './index.js';

const signal = new AbortController().signal;

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'repository.read_file',
    version: '1.0.0',
    description: 'Test tool',
    inputSchema: {},
    capabilities: ['workspace.read'],
    risk: 'safe',
    readOnly: true,
    idempotent: true,
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    origin: 'official-plugin',
    ...overrides,
  };
}

function call(workspaceRoot: string, overrides: Partial<GuardedToolCall> = {}): GuardedToolCall {
  const currentDefinition = overrides.definition ?? definition();
  return {
    callId: 'call-1',
    name: currentDefinition.name,
    arguments: { path: 'src/index.ts' },
    definition: currentDefinition,
    workspaceRoot,
    workspaceId: workspaceRoot,
    sessionId: 'session-1',
    mode: 'code',
    ...overrides,
  };
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'forge-policy-'));
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, '.git'));
  return directory;
}

describe('policy matrix', () => {
  it('allows inspection and denies every mutation under the read-only profile', async () => {
    const root = await workspace();
    const guard = new ImmutablePolicyGuard(READ_ONLY_POLICY);
    await expect(guard.evaluate(call(root), signal)).resolves.toMatchObject({
      decision: 'allow',
      match: { ruleId: 'read-only.allow-inspection' },
    });
    await expect(
      guard.evaluate(
        call(root, {
          definition: definition({
            name: 'editor.apply_patch',
            readOnly: false,
            risk: 'sensitive',
            capabilities: ['workspace.write'],
          }),
        }),
        signal,
      ),
    ).resolves.toMatchObject({
      decision: 'deny',
      reason: 'State-changing tools are forbidden in read-only mode',
      match: { ruleId: 'read-only.deny-mutation' },
    });
  });

  it('uses deny-first precedence and reports the exact winning rule', async () => {
    const root = await workspace();
    const guard = new ImmutablePolicyGuard(WORKSPACE_POLICY);
    const protectedWrite = call(root, {
      arguments: { path: '.git/config' },
      definition: definition({
        name: 'danger.remove',
        readOnly: false,
        risk: 'destructive',
        capabilities: ['workspace.write'],
      }),
    });
    await expect(guard.evaluate(protectedWrite, signal)).resolves.toMatchObject({
      decision: 'deny',
      match: {
        ruleId: 'workspace.deny-protected',
        evidence: { paths: ['.git/config'] },
      },
    });
  });

  it('requires approval for shell, network effects, and destructive tools', async () => {
    const root = await workspace();
    const guard = new ImmutablePolicyGuard(WORKSPACE_POLICY);
    const cases: readonly [GuardedToolCall, string][] = [
      [
        call(root, {
          arguments: { shell: 'printf hello' },
          definition: definition({
            name: 'shell.run',
            readOnly: false,
            risk: 'sensitive',
            capabilities: ['subprocess.execute'],
          }),
        }),
        'workspace.ask-shell',
      ],
      [
        call(root, {
          arguments: { url: 'https://api.example.com/hook' },
          definition: definition({
            name: 'http.post',
            readOnly: false,
            risk: 'sensitive',
            capabilities: ['network.write', 'external.side_effect'],
          }),
        }),
        'workspace.ask-external',
      ],
      [
        call(root, {
          definition: definition({
            name: 'cache.delete',
            readOnly: false,
            risk: 'destructive',
            capabilities: ['workspace.write'],
          }),
        }),
        'workspace.ask-destructive',
      ],
    ];
    for (const [current, ruleId] of cases) {
      await expect(guard.evaluate(current, signal)).resolves.toMatchObject({
        decision: 'ask',
        approvalId: expect.any(String),
        match: { ruleId },
      });
    }
  });

  it('matches tool, path, command, host, origin, capability, mode, and risk rules', async () => {
    const root = await workspace();
    const matrix: PolicySet = {
      id: 'matrix',
      defaultEffect: 'deny',
      defaultDescription: 'No matrix rule matched',
      rules: [
        {
          id: 'matrix.exact',
          description: 'All dimensions matched',
          effect: 'allow',
          tools: ['deploy.*'],
          modes: ['code'],
          risks: ['sensitive'],
          origins: ['official-plugin'],
          readOnly: false,
          capabilities: ['network.*'],
          paths: { access: 'write', patterns: ['src/**'] },
          commands: { executables: ['deployctl'] },
          network: { hosts: ['*.example.com'] },
          externalSideEffect: true,
        },
      ],
    };
    const current = call(root, {
      name: 'deploy.run',
      arguments: {
        path: 'src/release.ts',
        argv: ['deployctl', 'ship'],
        endpoint: 'https://api.example.com/v1',
      },
      definition: definition({
        name: 'deploy.run',
        readOnly: false,
        risk: 'sensitive',
        capabilities: ['network.write'],
      }),
    });
    await expect(new ImmutablePolicyGuard(matrix).evaluate(current, signal)).resolves.toMatchObject(
      {
        decision: 'allow',
        match: { ruleId: 'matrix.exact' },
      },
    );
  });
});

describe('approvals and security-root bypasses', () => {
  it('honors grants only in their exact session or workspace scope', async () => {
    const root = await workspace();
    const approvals = new ApprovalBroker();
    const guard = new ImmutablePolicyGuard(WORKSPACE_POLICY, approvals);
    const shellCall = call(root, {
      arguments: { shell: 'printf hello' },
      definition: definition({
        name: 'shell.run',
        readOnly: false,
        risk: 'sensitive',
        capabilities: ['subprocess.execute'],
      }),
    });
    approvals.grant({
      scope: 'session',
      scopeId: 'another-session',
      ruleId: 'workspace.ask-shell',
      tool: 'shell.*',
    });
    await expect(guard.evaluate(shellCall, signal)).resolves.toMatchObject({ decision: 'ask' });

    approvals.grant({
      scope: 'session',
      scopeId: 'session-1',
      ruleId: 'workspace.ask-shell',
      tool: 'shell.*',
    });
    await expect(guard.evaluate(shellCall, signal)).resolves.toMatchObject({
      decision: 'allow',
      match: { ruleId: 'workspace.ask-shell', evidence: { approved: true } },
    });

    const otherSession = { ...shellCall, sessionId: 'session-2' };
    await expect(guard.evaluate(otherSession, signal)).resolves.toMatchObject({ decision: 'ask' });
    approvals.grant({
      scope: 'workspace',
      scopeId: root,
      ruleId: 'workspace.ask-shell',
      tool: 'shell.run',
    });
    await expect(guard.evaluate(otherSession, signal)).resolves.toMatchObject({
      decision: 'allow',
    });
  });

  it('creates an approvable request when the default policy effect is ask', async () => {
    const root = await workspace();
    const approvals = new ApprovalBroker();
    const policy: PolicySet = {
      id: 'approval-default',
      rules: [],
      defaultEffect: 'ask',
      defaultDescription: 'Unknown tools require approval',
    };
    const guard = new ImmutablePolicyGuard(policy, approvals);
    const { workspaceId: _workspaceId, ...current } = call(root);
    await expect(guard.evaluate(current, signal)).resolves.toMatchObject({
      decision: 'ask',
      approvalId: expect.any(String),
      match: { ruleId: 'approval-default.default' },
    });
    approvals.grant({
      scope: 'workspace',
      scopeId: root,
      ruleId: 'approval-default.default',
      tool: 'repository.*',
    });
    await expect(guard.evaluate(current, signal)).resolves.toMatchObject({
      decision: 'allow',
      match: { ruleId: 'approval-default.default', evidence: { approved: true } },
    });
  });

  it('never lets an approval or later object mutation widen a deny rule', async () => {
    const root = await workspace();
    const approvals = new ApprovalBroker();
    approvals.grant({
      scope: 'workspace',
      scopeId: root,
      ruleId: 'workspace.ask-destructive',
      tool: '**',
    });
    approvals.grant({
      scope: 'workspace',
      scopeId: root,
      ruleId: 'workspace.deny-protected',
      tool: '**',
    });
    const source = structuredClone(WORKSPACE_POLICY);
    const guard = new ImmutablePolicyGuard(source, approvals);
    (source as unknown as { rules: PolicyRule[] }).rules = [];
    const current = call(root, {
      arguments: { path: '.git/config' },
      definition: definition({
        name: 'danger.remove',
        readOnly: false,
        risk: 'destructive',
        capabilities: ['workspace.write'],
      }),
    });
    await expect(guard.evaluate(current, signal)).resolves.toMatchObject({
      decision: 'deny',
      match: { ruleId: 'workspace.deny-protected' },
    });
    expect(Object.isFrozen(guard)).toBe(true);
    expect(Object.isFrozen(guard.policy.rules)).toBe(true);
  });

  it('prevents a later child plugin from replacing the managed security services', () => {
    const root = createForgeContext('security-root');
    const managed = createPluginContext(root, { name: 'managed-policy' });
    createWorkspacePolicyPlugin().setup(managed);
    const child = createPluginContext(root, { name: 'untrusted-child' });
    expect(() => createReadOnlyPolicyPlugin().setup(child)).toThrowError(
      expect.objectContaining({ code: 'SERVICE_CONFLICT' }),
    );
  });

  it('fails closed on traversal, absolute paths, symlinks, and malformed URLs', async () => {
    const root = await workspace();
    const guard = new ImmutablePolicyGuard(WORKSPACE_POLICY);
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'linked'));
    for (const arguments_ of [
      { path: '../outside' },
      { path: '/etc/passwd' },
      { path: 'linked/file.txt' },
      { url: 'file:///etc/passwd' },
      { endpoint: 'not a URL' },
    ]) {
      await expect(
        guard.evaluate(call(root, { arguments: arguments_ }), signal),
      ).resolves.toMatchObject({
        decision: 'deny',
        match: { ruleId: 'forge.security.invalid-resource' },
      });
    }
  });

  it('rejects a mismatched tool identity before evaluating policy rules', async () => {
    const root = await workspace();
    const guard = new ImmutablePolicyGuard(WORKSPACE_POLICY);
    await expect(
      guard.evaluate(call(root, { name: 'spoofed.tool' }), signal),
    ).resolves.toMatchObject({
      decision: 'deny',
      match: { ruleId: 'forge.security.tool-identity-mismatch' },
    });
  });
});
