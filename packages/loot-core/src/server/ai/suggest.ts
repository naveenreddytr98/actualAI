// @ts-strict-ignore
import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { integerToAmount } from '#shared/util';

import { callAnthropic, extractText } from './client';

const MODEL = 'claude-haiku-4-5-20251001';
// One-shot — we want the model to see the whole picture, not pieces of it.
const SAMPLE_SIZE = 800;

export type SuggestedCategory = {
  name: string;
  group: string;
  reason: string;
  exampleTransactions: string[];
};

export type SuggestCategoriesResult = {
  suggestions: SuggestedCategory[];
  errors: string[];
  scanned: number;
};

export type CreateCategoriesResult = {
  created: Array<{ name: string; group: string; id: string }>;
  skipped: Array<{ name: string; reason: string }>;
  errors: string[];
};

type ExistingCategory = {
  name: string;
  group: string;
  is_income: boolean;
};

type TransactionSample = {
  payee: string;
  amount: number;
  current_category: string | null;
};

async function loadExisting(): Promise<ExistingCategory[]> {
  const rows = await db.all<{
    name: string;
    group_name: string;
    is_income: 0 | 1;
  }>(
    `SELECT c.name AS name, cg.name AS group_name, cg.is_income AS is_income
     FROM categories c
     JOIN category_groups cg ON cg.id = c.cat_group
     WHERE c.tombstone = 0 AND cg.tombstone = 0
     ORDER BY cg.is_income, cg.sort_order, c.sort_order`,
  );
  return rows.map(r => ({
    name: r.name,
    group: r.group_name,
    is_income: r.is_income === 1,
  }));
}

async function loadSample(): Promise<TransactionSample[]> {
  const rows = await db.all<{
    payee_name: string | null;
    imported_payee: string | null;
    amount: number;
    category_name: string | null;
  }>(
    `SELECT p.name AS payee_name,
            t.imported_payee AS imported_payee,
            t.amount AS amount,
            c.name AS category_name
     FROM v_transactions_internal_alive t
     LEFT JOIN payees p ON p.id = t.payee
     LEFT JOIN categories c ON c.id = t.category
     WHERE COALESCE(t.is_parent, 0) = 0
     ORDER BY t.date DESC
     LIMIT ?`,
    [SAMPLE_SIZE],
  );
  return rows.map(r => ({
    payee: r.payee_name || r.imported_payee || '(unknown)',
    amount: integerToAmount(r.amount),
    current_category: r.category_name,
  }));
}

const SYSTEM_PROMPT = `You audit a personal-finance budget for missing categories.

You will receive:
  1. The user's existing categories (with the group each belongs to and whether the group is income).
  2. A sample of recent transactions, each showing payee, amount, and the category it currently has (or null if uncategorized).

Your job: identify a SHORT list (at most 6) of NEW categories that would meaningfully improve this budget — places where multiple real transactions are being forced into a generic catch-all (like "General") because no specific category fits.

Rules:
- Only propose a category if at least 3 distinct transactions in the sample would clearly fit it.
- Do not propose categories that already exist (case-insensitive match against the existing list).
- Do not propose income categories unless the data clearly shows recurring income that has no home.
- Each suggestion must name an existing group (from the provided list) — do not invent new groups.
- Output STRICT JSON, no prose, no markdown fences.

Output schema:
{
  "suggestions": [
    {
      "name": "<short title-cased category name>",
      "group": "<one of the existing group names>",
      "reason": "<one sentence explaining the gap>",
      "exampleTransactions": ["<payee 1>", "<payee 2>", "<payee 3>"]
    }
  ]
}

If no new categories are warranted, return {"suggestions": []}.`;

function parseSuggestions(text: string): SuggestedCategory[] {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    throw new Error('Model response missing "suggestions" array');
  }
  return parsed.suggestions.map(
    (s: {
      name: unknown;
      group: unknown;
      reason: unknown;
      exampleTransactions: unknown;
    }) => ({
      name: String(s.name ?? '').trim(),
      group: String(s.group ?? '').trim(),
      reason: String(s.reason ?? '').trim(),
      exampleTransactions: Array.isArray(s.exampleTransactions)
        ? s.exampleTransactions.map(String).slice(0, 5)
        : [],
    }),
  );
}

export async function suggestNewCategories(): Promise<SuggestCategoriesResult> {
  const apiKey = await asyncStorage.getItem('anthropic-api-key');
  if (!apiKey) {
    return {
      suggestions: [],
      scanned: 0,
      errors: ['No Anthropic API key configured'],
    };
  }

  const [existing, sample] = await Promise.all([loadExisting(), loadSample()]);
  if (sample.length === 0) {
    return { suggestions: [], scanned: 0, errors: [] };
  }

  const validGroups = new Set(existing.map(c => c.group));
  const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

  try {
    const response = await callAnthropic(apiKey, {
      model: MODEL,
      max_tokens: 2048,
      temperature: 0,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        {
          type: 'text',
          text:
            'Existing categories (JSON):\n' +
            JSON.stringify(
              existing.map(c => ({
                name: c.name,
                group: c.group,
                is_income: c.is_income,
              })),
            ),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content:
            'Recent transactions sample (JSON):\n' + JSON.stringify(sample),
        },
      ],
    });

    const raw = parseSuggestions(extractText(response));
    // Drop suggestions that reference an unknown group or duplicate an
    // existing category — the model occasionally fabricates either.
    const cleaned = raw.filter(
      s =>
        s.name &&
        validGroups.has(s.group) &&
        !existingNames.has(s.name.toLowerCase()),
    );
    return { suggestions: cleaned, scanned: sample.length, errors: [] };
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
    return { suggestions: [], scanned: sample.length, errors: [message] };
  }
}

export async function createSuggestedCategories({
  picks,
}: {
  picks: Array<{ name: string; group: string }>;
}): Promise<CreateCategoriesResult> {
  if (!picks || picks.length === 0) {
    return { created: [], skipped: [], errors: [] };
  }

  // Pull current groups + categories so we can map group-name → group-id and
  // detect duplicates without trusting the client.
  const groups = await db.all<{
    id: string;
    name: string;
    is_income: 0 | 1;
  }>(`SELECT id, name, is_income FROM category_groups WHERE tombstone = 0`);
  const groupByLower = new Map(groups.map(g => [g.name.toLowerCase(), g]));
  const existing = await db.all<{ name: string; cat_group: string }>(
    `SELECT name, cat_group FROM categories WHERE tombstone = 0`,
  );
  const existingKey = new Set(
    existing.map(e => `${e.cat_group}::${e.name.toLowerCase()}`),
  );

  const created: CreateCategoriesResult['created'] = [];
  const skipped: CreateCategoriesResult['skipped'] = [];
  const errors: string[] = [];

  for (const pick of picks) {
    const name = (pick.name ?? '').trim();
    const groupName = (pick.group ?? '').trim();
    if (!name) {
      skipped.push({ name: pick.name ?? '', reason: 'empty name' });
      continue;
    }
    const group = groupByLower.get(groupName.toLowerCase());
    if (!group) {
      skipped.push({ name, reason: `unknown group "${groupName}"` });
      continue;
    }
    if (existingKey.has(`${group.id}::${name.toLowerCase()}`)) {
      skipped.push({ name, reason: 'already exists in that group' });
      continue;
    }
    try {
      const id = await db.insertCategory({
        name,
        cat_group: group.id,
        is_income: group.is_income,
        hidden: 0,
      });
      created.push({ name, group: group.name, id });
      // Track so back-to-back inserts in the same call dedupe correctly.
      existingKey.add(`${group.id}::${name.toLowerCase()}`);
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      errors.push(`${name}: ${message}`);
    }
  }

  return { created, skipped, errors };
}
