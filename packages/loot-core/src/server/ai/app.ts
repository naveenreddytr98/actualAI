import * as asyncStorage from '#platform/server/asyncStorage';
import { createApp } from '#server/app';
import { mutator } from '#server/mutators';
import { undoable } from '#server/undo';

import { applyCategoryProposals, proposeCategories } from './categorize';
import type {
  ApplyCategoryProposalsResult,
  ProposeCategoriesResult,
} from './categorize';
import { callAnthropic } from './client';
import { createSuggestedCategories, suggestNewCategories } from './suggest';
import type {
  CreateCategoriesResult,
  SuggestCategoriesResult,
} from './suggest';

export type AIHandlers = {
  'ai-propose-categories': typeof handleProposeCategories;
  'ai-apply-category-proposals': typeof handleApplyCategoryProposals;
  'ai-suggest-categories': typeof handleSuggestCategories;
  'ai-create-categories': typeof handleCreateCategories;
  'ai-test-api-key': typeof handleTestApiKey;
};

export const app = createApp<AIHandlers>();

app.method('ai-propose-categories', handleProposeCategories);
app.method(
  'ai-apply-category-proposals',
  mutator(undoable(handleApplyCategoryProposals)),
);
app.method('ai-suggest-categories', handleSuggestCategories);
app.method('ai-create-categories', mutator(undoable(handleCreateCategories)));
app.method('ai-test-api-key', handleTestApiKey);

async function handleProposeCategories(
  args: { accountId?: string } = {},
): Promise<ProposeCategoriesResult> {
  return proposeCategories(args);
}

async function handleApplyCategoryProposals(args: {
  picks: Array<{ transactionId: string; categoryId: string }>;
}): Promise<ApplyCategoryProposalsResult> {
  return applyCategoryProposals(args?.picks ?? []);
}

async function handleSuggestCategories(): Promise<SuggestCategoriesResult> {
  return suggestNewCategories();
}

async function handleCreateCategories(args: {
  picks: Array<{ name: string; group: string }>;
}): Promise<CreateCategoriesResult> {
  return createSuggestedCategories(args);
}

async function handleTestApiKey(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const apiKey = await asyncStorage.getItem('anthropic-api-key');
  if (!apiKey) {
    return { ok: false, error: 'No API key configured' };
  }
  try {
    // Minimal ping — single token, single message. Validates auth + reachability.
    await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
    return { ok: false, error: message };
  }
}
