import { serviceToken } from '@forge/kernel-contracts';

export interface ContextRequest {
  readonly query: string;
  readonly tokenBudget: number;
  readonly signal?: AbortSignal;
}

export interface ContextSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number;
  readonly estimatedTokens: number;
}

export interface ContextProvider {
  readonly id: string;
  provide(request: ContextRequest): Promise<ContextSection | undefined>;
}

export interface AssembledContext {
  readonly sections: readonly ContextSection[];
  readonly text: string;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export class ContextAssembler {
  readonly #providers = new Map<string, ContextProvider>();

  register(provider: ContextProvider): () => void {
    if (this.#providers.has(provider.id)) throw new Error(`Context provider ${provider.id} exists`);
    this.#providers.set(provider.id, provider);
    return () => {
      if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id);
    };
  }

  async assemble(request: ContextRequest): Promise<AssembledContext> {
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) {
      throw new Error('Context token budget must be a positive integer');
    }
    const provided = await Promise.all(
      [...this.#providers.values()].map((provider) => provider.provide(request)),
    );
    const candidates = provided
      .filter((section): section is ContextSection => section !== undefined)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const sections: ContextSection[] = [];
    let remaining = request.tokenBudget;
    let truncated = false;
    for (const section of candidates) {
      const heading = `## ${section.title}\n`;
      const separator = sections.length > 0 ? '\n\n' : '';
      const framingTokens = estimateTokens(`${separator}${heading}`);
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (framingTokens >= remaining) {
        truncated = true;
        break;
      }
      const contentBudget = remaining - framingTokens;
      if (estimateTokens(section.content) <= contentBudget) {
        sections.push(section);
        remaining -= framingTokens + estimateTokens(section.content);
      } else {
        const content = takeCharacters(section.content, contentBudget * 4);
        sections.push({ ...section, content, estimatedTokens: estimateTokens(content) });
        remaining = 0;
        truncated = true;
      }
    }
    const text = sections.map((section) => `## ${section.title}\n${section.content}`).join('\n\n');
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens > request.tokenBudget) {
      throw new Error('Context assembler exceeded its token budget');
    }
    return {
      sections,
      text,
      estimatedTokens,
      truncated: truncated || sections.length < candidates.length,
    };
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function takeCharacters(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('');
}

export const CONTEXT_PROVIDER_SERVICE = serviceToken<ContextProvider>(
  'forge.context-provider',
  'multiple',
);
export const CONTEXT_ASSEMBLER_SERVICE = serviceToken<ContextAssembler>('forge.context-assembler');
