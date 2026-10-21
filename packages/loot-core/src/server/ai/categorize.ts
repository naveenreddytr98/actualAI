import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import { integerToAmount } from '#shared/util';
import type { TransactionEntity } from '#types/models';

import { callAnthropic, extractText } from './client';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_BATCH = 40;
// The review list is the latest uncategorized rows. A second review covers the rest.
const MAX_CANDIDATES = 200;

const ELIGIBLE_WHERE = `
  COALESCE(t.is_parent, 0) = 0
  AND COALESCE(t.reconciled, 0) = 0
  AND COALESCE(t.starting_balance_flag, 0) = 0
  AND t.category IS NULL
  AND (
    p.transfer_acct IS NULL
    OR COALESCE(transfer_account.offbudget, 0) = 1
  )
`;

const CANDIDATE_FROM = `
  FROM v_transactions_internal_alive t
  LEFT JOIN payees p ON p.id = t.payee
  LEFT JOIN accounts transfer_account ON transfer_account.id = p.transfer_acct
`;

type CategorySummary = {
  id: string;
  name: string;
  group: string;
  is_income: boolean;
};

export type CategoryCandidate = {
  id: string;
  payee: string;
  amount: number;
  date: string;
};

export type CategoryProposal = {
  transactionId: string;
  payee: string;
  amount: number;
  date: string;
  categoryId: string;
  categoryName: string;
};

export type ProposeCategoriesResult = {
  proposals: CategoryProposal[];
  total: number;
  skipped: number;
  truncated: boolean;
  errors: string[];
};

export type ApplyCategoryProposalsResult = {
  applied: number;
  skipped: number;
  errors: string[];
};

export type CategoryPick = {
  transactionId: string;
  categoryId: string;
};

type ParsedCategorization = {
  n: number;
  categoryRef: string | null;
};

// A negative amount is an outflow. An income category would file that purchase as income.
// A positive amount may be income, or a refund back to an expense category.
export function categoryFitsAmount(amount: number, isIncome: boolean): boolean {
  if (amount < 0 && isIncome) {
    return false;
  }
  return true;
}

export function toPromptTransaction(
  index: number,
  row: { payee: string; amount: number; date: string },
) {
  return {
    n: index,
    payee: row.payee,
    amount: integerToAmount(row.amount),
    date: row.date,
  };
}

export function toPromptCategory(index: number, category: CategorySummary) {
  return {
    ref: `c${index}`,
    name: category.name,
    group: category.group,
    is_income: category.is_income,
  };
}

export function parseCategorizations(text: string): ParsedCategorization[] {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('categorizations' in parsed) ||
    !Array.isArray(parsed.categorizations)
  ) {
    throw new Error('Model response missing "categorizations" array');
  }
  return parsed.categorizations.map(item => {
    const row = item as { n?: unknown; categoryRef?: unknown };
    const categoryRef =
      row.categoryRef == null || row.categoryRef === ''
        ? null
        : String(row.categoryRef);
    return {
      n: Number(row.n),
      categoryRef,
    };
  });
}

export function buildProposals(
  parsed: ParsedCategorization[],
  batch: CategoryCandidate[],
  categories: Array<CategorySummary & { ref: string }>,
): { proposals: CategoryProposal[]; skipped: number } {
  const byRef = new Map(categories.map(category => [category.ref, category]));
  const seen = new Set<number>();
  const proposals: CategoryProposal[] = [];
  let skipped = 0;

  for (const item of parsed) {
    if (!Number.isInteger(item.n) || seen.has(item.n)) {
      skipped++;
      continue;
    }
    seen.add(item.n);
    const transaction = batch[item.n];
    const category = item.categoryRef ? byRef.get(item.categoryRef) : undefined;
    if (!transaction || !category) {
      skipped++;
      continue;
    }
    if (!categoryFitsAmount(transaction.amount, category.is_income)) {
      skipped++;
      continue;
    }
    proposals.push({
      transactionId: transaction.id,
      payee: transaction.payee,
      amount: transaction.amount,
      date: transaction.date,
      categoryId: category.id,
      categoryName: category.name,
    });
  }

  skipped += batch.length - seen.size;
  return { proposals, skipped };
}

function formatDbDate(value: number | string | null): string {
  if (value == null) {
    return '';
  }
  const text = String(value);
  if (!/^\d{8}$/.test(text)) {
    return text;
  }
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

async function loadCategories(): Promise<CategorySummary[]> {
  const rows = await db.all<{
    id: string;
    name: string;
    group_name: string;
    is_income: 0 | 1;
  }>(
    `SELECT c.id AS id, c.name AS name, cg.name AS group_name, cg.is_income AS is_income
     FROM categories c
     JOIN category_groups cg ON cg.id = c.cat_group
     WHERE c.tombstone = 0 AND cg.tombstone = 0 AND COALESCE(c.hidden, 0) = 0
     ORDER BY cg.is_income, cg.sort_order, c.sort_order`,
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    group: row.group_name,
    is_income: row.is_income === 1,
  }));
}

function mapCandidate(row: {
  id: string;
  payee: string | null;
  amount: number;
  date: number | string | null;
}): CategoryCandidate {
  return {
    id: row.id,
    payee: row.payee || '(unknown)',
    amount: row.amount,
    date: formatDbDate(row.date),
  };
}

export async function loadCategoryCandidates(
  opts: {
    accountId?: string;
    limit?: number;
  } = {},
): Promise<CategoryCandidate[]> {
  const params: Array<string | number> = [];
  let where = ELIGIBLE_WHERE;
  if (opts.accountId) {
    where += ' AND t.account = ?';
    params.push(opts.accountId);
  }
  params.push(opts.limit ?? MAX_CANDIDATES);
  const rows = await db.all<{
    id: string;
    payee: string | null;
    amount: number;
    date: number | string | null;
  }>(
    `SELECT t.id AS id,
            COALESCE(
              NULLIF(p.name, ''),
              NULLIF(t.imported_payee, ''),
              NULLIF(transfer_account.name, ''),
              '(unknown)'
            ) AS payee,
            t.amount AS amount,
            t.date AS date
     ${CANDIDATE_FROM}
     WHERE ${where}
     ORDER BY t.date DESC
     LIMIT ?`,
    params,
  );
  return rows.map(mapCandidate);
}

const SYSTEM_PROMPT = `You categorize personal-finance transactions.

Amounts use the account currency. A negative amount is an outflow and must use an expense category (is_income false). A positive amount is an inflow: use an income category for pay, interest, and similar income, and an expense category only when it is clearly a refund of a purchase. If you cannot tell, use null.

You will receive categories identified by ref, and transactions identified by n. Do not invent refs.

Output STRICT JSON with no prose and no markdown fences:
{"categorizations":[{"n":0,"categoryRef":"c0"}]}`;

async function suggestBatch(
  apiKey: string,
  categories: Array<CategorySummary & { ref: string }>,
  batch: CategoryCandidate[],
): Promise<ParsedCategorization[]> {
  const response = await callAnthropic(apiKey, {
    model: MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      {
        type: 'text',
        text:
          'Available categories (JSON):\n' +
          JSON.stringify(
            categories.map(category => ({
              ref: category.ref,
              name: category.name,
              group: category.group,
              is_income: category.is_income,
            })),
          ),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          'Categorize these transactions (JSON):\n' +
          JSON.stringify(
            batch.map((row, index) => toPromptTransaction(index, row)),
          ),
      },
    ],
  });

  return parseCategorizations(extractText(response));
}

export async function proposeCategories({
  accountId,
}: {
  accountId?: string;
} = {}): Promise<ProposeCategoriesResult> {
  const apiKey = await asyncStorage.getItem('anthropic-api-key');
  if (!apiKey) {
    return {
      proposals: [],
      total: 0,
      skipped: 0,
      truncated: false,
      errors: ['No Anthropic API key configured'],
    };
  }

  const [categories, transactions] = await Promise.all([
    loadCategories(),
    loadCategoryCandidates({ accountId, limit: MAX_CANDIDATES + 1 }),
  ]);

  if (categories.length === 0) {
    return {
      proposals: [],
      total: 0,
      skipped: 0,
      truncated: false,
      errors: ['No categories defined'],
    };
  }

  const truncated = transactions.length > MAX_CANDIDATES;
  const candidates = truncated
    ? transactions.slice(0, MAX_CANDIDATES)
    : transactions;

  if (candidates.length === 0) {
    return {
      proposals: [],
      total: 0,
      skipped: 0,
      truncated: false,
      errors: [],
    };
  }

  const categoriesWithRefs = categories.map((category, index) => ({
    ...category,
    ref: `c${index}`,
  }));
  const errors: string[] = [];
  const proposals: CategoryProposal[] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += MAX_BATCH) {
    const batch = candidates.slice(i, i + MAX_BATCH);
    try {
      const parsed = await suggestBatch(apiKey, categoriesWithRefs, batch);
      const built = buildProposals(parsed, batch, categoriesWithRefs);
      proposals.push(...built.proposals);
      skipped += built.skipped;
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : String(err);
      errors.push(`Batch ${i / MAX_BATCH + 1}: ${message}`);
      skipped += batch.length;
    }
  }

  return {
    proposals,
    total: candidates.length,
    skipped,
    truncated,
    errors,
  };
}

export async function applyCategoryProposals(
  picks: CategoryPick[],
): Promise<ApplyCategoryProposalsResult> {
  const requested = new Map<string, string>();
  for (const pick of picks) {
    const transactionId = pick?.transactionId?.trim();
    const categoryId = pick?.categoryId?.trim();
    if (!transactionId || !categoryId) {
      continue;
    }
    requested.set(transactionId, categoryId);
  }

  if (requested.size === 0) {
    return { applied: 0, skipped: picks.length, errors: [] };
  }

  const categories = await loadCategories();
  const categoryById = new Map(
    categories.map(category => [category.id, category]),
  );
  const ids = [...requested.keys()];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all<{ id: string; amount: number }>(
    `SELECT t.id AS id, t.amount AS amount
     ${CANDIDATE_FROM}
     WHERE ${ELIGIBLE_WHERE}
       AND t.id IN (${placeholders})`,
    ids,
  );
  const eligible = new Map(rows.map(row => [row.id, row.amount]));

  const updates: Array<Pick<TransactionEntity, 'id' | 'category'>> = [];
  for (const [transactionId, categoryId] of requested) {
    const amount = eligible.get(transactionId);
    const category = categoryById.get(categoryId);
    if (amount === undefined || !category) {
      continue;
    }
    if (!categoryFitsAmount(amount, category.is_income)) {
      continue;
    }
    updates.push({ id: transactionId, category: categoryId });
  }

  if (updates.length > 0) {
    try {
      await batchUpdateTransactions({
        updated: updates,
        learnCategories: true,
      });
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : String(err);
      return {
        applied: 0,
        skipped: requested.size,
        errors: [message],
      };
    }
  }

  return {
    applied: updates.length,
    skipped: requested.size - updates.length,
    errors: [],
  };
}
