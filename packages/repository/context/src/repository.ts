import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContextProvider, ContextRequest, ContextSection } from './context.js';
import { estimateTokens } from './context.js';

export interface RepositoryRootInput {
  readonly id?: string;
  readonly path: string;
}

export interface RepositoryContextOptions {
  readonly roots: readonly RepositoryRootInput[];
  readonly ignore?: readonly string[];
  readonly secretPaths?: readonly string[];
  readonly maxFileBytes?: number;
  readonly maxReadBytes?: number;
}

export interface RepositoryFile {
  readonly rootId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedMs: number;
  readonly language: string;
  readonly hash: string;
  readonly symbols: readonly RepositorySymbol[];
  readonly imports: readonly string[];
}

export interface RepositorySymbol {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly signature: string;
}

export interface TextMatch {
  readonly rootId: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface RepositoryRead {
  readonly rootId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly hash: string;
}

export interface RepositoryMap {
  readonly content: string;
  readonly files: readonly string[];
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

interface IndexedFile extends RepositoryFile {
  readonly version: string;
  readonly content: string;
}

interface RootState {
  readonly id: string;
  readonly path: string;
  readonly ignoreRules: readonly IgnoreRule[];
}

interface IgnoreRule {
  readonly negate: boolean;
  readonly regex: RegExp;
}

const DEFAULT_IGNORES = ['.git/', 'node_modules/', '.forge/', 'dist/', 'build/', 'coverage/'];
const DEFAULT_SECRET_PATHS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  '*credentials*',
  '*secret*',
];
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  '7z',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'woff',
  'woff2',
  'ttf',
]);

export class RepositoryContext implements ContextProvider {
  readonly id = 'repository-map';
  readonly #options: Required<Pick<RepositoryContextOptions, 'maxFileBytes' | 'maxReadBytes'>> &
    RepositoryContextOptions;
  readonly #files = new Map<string, IndexedFile>();
  #roots: readonly RootState[] | undefined;

  constructor(options: RepositoryContextOptions) {
    if (options.roots.length === 0) throw new Error('At least one repository root is required');
    this.#options = {
      ...options,
      maxFileBytes: options.maxFileBytes ?? 1_000_000,
      maxReadBytes: options.maxReadBytes ?? 128_000,
    };
  }

  async refresh(signal?: AbortSignal): Promise<readonly RepositoryFile[]> {
    const roots = await this.#resolveRoots();
    const seen = new Set<string>();
    for (const root of roots) await this.#walk(root, '', seen, signal);
    for (const key of this.#files.keys()) {
      if (!seen.has(key)) this.#files.delete(key);
    }
    return this.inventory();
  }

  inventory(): readonly RepositoryFile[] {
    return [...this.#files.values()]
      .map(({ content: _content, version: _version, ...file }) => file)
      .sort(compareFiles);
  }

  invalidate(paths?: readonly { readonly rootId: string; readonly path: string }[]): void {
    if (!paths) {
      this.#files.clear();
      return;
    }
    for (const path of paths)
      this.#files.delete(fileKey(path.rootId, normalizeRelative(path.path)));
  }

  async glob(pattern: string, signal?: AbortSignal): Promise<readonly RepositoryFile[]> {
    await this.refresh(signal);
    const regex = globRegex(pattern);
    return this.inventory().filter((file) => regex.test(file.path));
  }

  async searchText(
    query: string,
    options: { readonly maxResults?: number; readonly signal?: AbortSignal } = {},
  ): Promise<readonly TextMatch[]> {
    if (!query) throw new Error('Search query cannot be empty');
    await this.refresh(options.signal);
    const maximum = options.maxResults ?? 100;
    const matches: TextMatch[] = [];
    for (const file of [...this.#files.values()].sort(compareFiles)) {
      for (const [index, line] of file.content.split('\n').entries()) {
        const column = line.indexOf(query);
        if (column < 0) continue;
        matches.push({
          rootId: file.rootId,
          path: file.path,
          line: index + 1,
          column: column + 1,
          excerpt: takeAround(line, column, query.length, 240),
        });
        if (matches.length >= maximum) return matches;
      }
    }
    return matches;
  }

  async read(
    rootId: string,
    path: string,
    options: {
      readonly startLine?: number;
      readonly endLine?: number;
      readonly maxBytes?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RepositoryRead> {
    await this.refresh(options.signal);
    const relativePath = normalizeRelative(path);
    const file = this.#files.get(fileKey(rootId, relativePath));
    if (!file)
      throw new Error(`Repository file ${rootId}:${relativePath} is unavailable or excluded`);
    const lines = file.content.split('\n');
    const startLine = options.startLine ?? 1;
    const requestedEnd = options.endLine ?? lines.length;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(requestedEnd) ||
      startLine < 1 ||
      requestedEnd < startLine
    ) {
      throw new Error('Read line range is invalid');
    }
    const selected = lines.slice(startLine - 1, requestedEnd).join('\n');
    const maximum = Math.min(
      options.maxBytes ?? this.#options.maxReadBytes,
      this.#options.maxReadBytes,
    );
    const content = takeUtf8(selected, maximum);
    return {
      rootId,
      path: relativePath,
      startLine,
      endLine: Math.min(requestedEnd, lines.length),
      content,
      truncated: content !== selected,
      hash: file.hash,
    };
  }

  async map(query: string, tokenBudget: number, signal?: AbortSignal): Promise<RepositoryMap> {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      throw new Error('Repository-map token budget must be positive');
    }
    await this.refresh(signal);
    const terms = termsFrom(query);
    const ranked = [...this.#files.values()]
      .map((file) => ({ file, score: rankFile(file, terms) }))
      .sort((left, right) => right.score - left.score || compareFiles(left.file, right.file));
    const included: string[] = [];
    const chunks: string[] = [];
    let remainingCharacters = tokenBudget * 4;
    let truncated = false;
    for (const { file } of ranked) {
      const signatures = file.symbols
        .slice(0, 12)
        .map((symbol) => `  L${symbol.line} ${symbol.signature}`);
      const imports =
        file.imports.length > 0 ? [`  imports: ${file.imports.slice(0, 8).join(', ')}`] : [];
      const chunk = [`${file.rootId}:${file.path}`, ...signatures, ...imports].join('\n');
      if (chunk.length + 1 > remainingCharacters) {
        truncated = true;
        continue;
      }
      chunks.push(chunk);
      included.push(`${file.rootId}:${file.path}`);
      remainingCharacters -= chunk.length + 1;
    }
    const content = chunks.join('\n');
    return { content, files: included, estimatedTokens: estimateTokens(content), truncated };
  }

  async provide(request: ContextRequest): Promise<ContextSection> {
    const map = await this.map(request.query, request.tokenBudget, request.signal);
    return {
      id: this.id,
      title: 'Repository map',
      content: map.content,
      priority: 50,
      estimatedTokens: map.estimatedTokens,
    };
  }

  async #resolveRoots(): Promise<readonly RootState[]> {
    if (this.#roots) return this.#roots;
    const roots: RootState[] = [];
    const ids = new Set<string>();
    for (const input of this.#options.roots) {
      const path = await realpath(resolve(input.path));
      const id = input.id ?? (basename(path) || 'root');
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
        throw new Error(`Invalid or duplicate root id: ${id}`);
      ids.add(id);
      let gitignore = '';
      try {
        gitignore = await readFile(resolve(path, '.gitignore'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const rules = [...DEFAULT_IGNORES, ...(this.#options.ignore ?? []), ...gitignore.split('\n')]
        .map(parseIgnoreRule)
        .filter((rule): rule is IgnoreRule => rule !== undefined);
      roots.push({ id, path, ignoreRules: rules });
    }
    this.#roots = roots;
    return roots;
  }

  async #walk(
    root: RootState,
    directory: string,
    seen: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const absoluteDirectory = resolve(root.path, directory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const path = normalizeRelative(directory ? `${directory}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink() || isIgnored(path, entry.isDirectory(), root.ignoreRules))
        continue;
      if (entry.isDirectory()) {
        await this.#walk(root, path, seen, signal);
        continue;
      }
      if (!entry.isFile() || isSecretPath(path, this.#options.secretPaths ?? DEFAULT_SECRET_PATHS))
        continue;
      const absolute = resolve(root.path, path);
      const metadata = await stat(absolute);
      if (metadata.size > this.#options.maxFileBytes || isBinaryExtension(path)) continue;
      const version = `${metadata.size}:${metadata.mtimeMs}`;
      const key = fileKey(root.id, path);
      seen.add(key);
      if (this.#files.get(key)?.version === version) continue;
      const buffer = await readFile(absolute);
      if (buffer.subarray(0, 8_192).includes(0)) {
        this.#files.delete(key);
        continue;
      }
      const content = buffer.toString('utf8');
      this.#files.set(key, {
        rootId: root.id,
        path,
        sizeBytes: buffer.length,
        modifiedMs: metadata.mtimeMs,
        language: languageFor(path),
        hash: createHash('sha256').update(buffer).digest('hex'),
        symbols: extractSymbols(content),
        imports: extractImports(content),
        version,
        content,
      });
    }
  }
}

function parseIgnoreRule(line: string): IgnoreRule | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const negate = trimmed.startsWith('!');
  const pattern = (negate ? trimmed.slice(1) : trimmed).replace(/^\//, '');
  return { negate, regex: globRegex(pattern, true) };
}

function isIgnored(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  const candidate = directory ? `${path}/` : path;
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(candidate)) ignored = !rule.negate;
  }
  return ignored;
}

export function globRegex(pattern: string, ignoreRule = false): RegExp {
  const normalized = pattern.replaceAll('\\', '/');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        source += normalized[index + 1] === '/' ? '(?:.*/)?' : '.*';
        if (normalized[index + 1] === '/') index += 1;
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else if (character === '/') source += '/';
    else source += character?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? '';
  }
  const hasSlash = normalized.includes('/');
  const prefix = hasSlash ? '^' : '(?:^|.*/)';
  const directorySuffix = normalized.endsWith('/') ? '.*' : ignoreRule ? '(?:$|/.*)' : '$';
  return new RegExp(`${prefix}${source}${directorySuffix}`);
}

function isSecretPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern, true).test(path));
}

function isBinaryExtension(path: string): boolean {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return BINARY_EXTENSIONS.has(extension);
}

function normalizeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0'))
    throw new Error('Repository path must be relative');
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error('Repository path escapes its root');
  }
  return normalized;
}

function fileKey(rootId: string, path: string): string {
  return `${rootId}\0${path}`;
}

function compareFiles(left: RepositoryFile, right: RepositoryFile): number {
  return left.rootId.localeCompare(right.rootId) || left.path.localeCompare(right.path);
}

function extractSymbols(content: string): readonly RepositorySymbol[] {
  const symbols: RepositorySymbol[] = [];
  const patterns: readonly [string, RegExp][] = [
    ['function', /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/],
    ['class', /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/],
    ['interface', /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
    ['type', /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/],
    ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/],
    ['function', /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/],
    ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/],
    ['class', /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/],
  ];
  for (const [index, line] of content.split('\n').entries()) {
    for (const [kind, pattern] of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        symbols.push({
          name: match[1],
          kind,
          line: index + 1,
          signature: Array.from(line.trim()).slice(0, 180).join(''),
        });
        break;
      }
    }
  }
  return symbols;
}

function extractImports(content: string): readonly string[] {
  const imports = new Set<string>();
  for (const line of content.split('\n')) {
    const match = /(?:from\s+|require\s*\(|import\s*\()['"]([^'"]+)/.exec(line);
    if (match?.[1]) imports.add(match[1]);
  }
  return [...imports].sort();
}

function termsFrom(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$.-]+/)
    .filter((term) => term.length > 1);
}

function rankFile(file: IndexedFile, terms: readonly string[]): number {
  const haystack = `${file.path} ${file.symbols.map(({ name }) => name).join(' ')}`.toLowerCase();
  let score = /(?:^|\/)(?:readme|package\.json|pyproject\.toml|cargo\.toml)$/i.test(file.path)
    ? 20
    : 0;
  for (const term of terms) {
    if (file.path.toLowerCase().includes(term)) score += 12;
    if (haystack.includes(term)) score += 6;
  }
  score += Math.min(5, file.symbols.length);
  return score;
}

function languageFor(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        py: 'python',
        rs: 'rust',
        go: 'go',
        md: 'markdown',
        json: 'json',
        toml: 'toml',
      } as Record<string, string>
    )[extension] ?? 'text'
  );
}

function takeAround(line: string, column: number, length: number, maximum: number): string {
  if (line.length <= maximum) return line;
  const start = Math.max(0, column - Math.floor((maximum - length) / 2));
  return line.slice(start, start + maximum);
}

function takeUtf8(text: string, maximum: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

export function assertInsideRoot(root: string, candidate: string): void {
  const path = resolve(candidate);
  const relation = relative(resolve(root), path);
  if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) {
    throw new Error('Path escapes repository root');
  }
}
