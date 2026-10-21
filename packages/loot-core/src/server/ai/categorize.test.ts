import * as db from '#server/db';

import {
  applyCategoryProposals,
  buildProposals,
  categoryFitsAmount,
  loadCategoryCandidates,
  parseCategorizations,
  toPromptCategory,
  toPromptTransaction,
} from './categorize';
import type { CategoryCandidate } from './categorize';

beforeEach(global.emptyDatabase());

describe('categoryFitsAmount', () => {
  it('rejects an income category on an outflow', () => {
    expect(categoryFitsAmount(-2500, true)).toBe(false);
  });

  it('allows an expense category on an outflow', () => {
    expect(categoryFitsAmount(-2500, false)).toBe(true);
  });

  it('allows an expense category on an inflow so a refund can be filed', () => {
    expect(categoryFitsAmount(2500, false)).toBe(true);
  });

  it('allows an income category on an inflow', () => {
    expect(categoryFitsAmount(2500, true)).toBe(true);
  });
});

describe('parseCategorizations', () => {
  it('reads a fenced JSON payload', () => {
    const parsed = parseCategorizations(
      '```json\n{"categorizations":[{"n":0,"categoryRef":"c1"},{"n":1,"categoryRef":null}]}\n```',
    );
    expect(parsed).toEqual([
      { n: 0, categoryRef: 'c1' },
      { n: 1, categoryRef: null },
    ]);
  });

  it('rejects a payload without the categorizations array', () => {
    expect(() => parseCategorizations('{"ok":true}')).toThrow(
      /categorizations/,
    );
  });
});

describe('prompt payload', () => {
  it('sends payee, amount, and date only', () => {
    expect(
      toPromptTransaction(3, {
        payee: 'Market',
        amount: -1234,
        date: '2026-01-02',
      }),
    ).toEqual({
      n: 3,
      payee: 'Market',
      amount: -12.34,
      date: '2026-01-02',
    });
  });

  it('identifies categories by a short ref', () => {
    expect(
      toPromptCategory(1, {
        id: 'secret-id',
        name: 'Groceries',
        group: 'Food',
        is_income: false,
      }),
    ).toEqual({
      ref: 'c1',
      name: 'Groceries',
      group: 'Food',
      is_income: false,
    });
  });
});

describe('buildProposals', () => {
  const batch: CategoryCandidate[] = [
    {
      id: 'txn-out',
      payee: 'Market',
      amount: -5000,
      date: '2026-01-02',
    },
    {
      id: 'txn-in',
      payee: 'Payroll',
      amount: 100000,
      date: '2026-01-03',
    },
  ];
  const categories = [
    {
      ref: 'c0',
      id: 'groceries',
      name: 'Groceries',
      group: 'Food',
      is_income: false,
    },
    {
      ref: 'c1',
      id: 'paycheck',
      name: 'Paycheck',
      group: 'Income',
      is_income: true,
    },
  ];

  it('maps a ref back to the transaction and drops a bad side', () => {
    const built = buildProposals(
      [
        { n: 0, categoryRef: 'c0' },
        { n: 0, categoryRef: 'c1' },
        { n: 1, categoryRef: 'c1' },
        { n: 4, categoryRef: 'c0' },
        { n: 2, categoryRef: null },
      ],
      batch,
      categories,
    );

    expect(built.proposals).toEqual([
      {
        transactionId: 'txn-out',
        payee: 'Market',
        amount: -5000,
        date: '2026-01-02',
        categoryId: 'groceries',
        categoryName: 'Groceries',
      },
      {
        transactionId: 'txn-in',
        payee: 'Payroll',
        amount: 100000,
        date: '2026-01-03',
        categoryId: 'paycheck',
        categoryName: 'Paycheck',
      },
    ]);
  });

  it('drops an income category suggested for an outflow', () => {
    const built = buildProposals(
      [{ n: 0, categoryRef: 'c1' }],
      batch,
      categories,
    );
    expect(built.proposals).toEqual([]);
    expect(built.skipped).toBe(2);
  });
});

async function seedBudget() {
  await db.insertCategoryGroup({
    id: 'expense-group',
    name: 'Food',
    is_income: 0,
  });
  await db.insertCategoryGroup({
    id: 'income-group',
    name: 'Income',
    is_income: 1,
  });
  const groceries = await db.insertCategory({
    id: 'groceries',
    name: 'Groceries',
    cat_group: 'expense-group',
    is_income: 0,
  });
  const paycheck = await db.insertCategory({
    id: 'paycheck',
    name: 'Paycheck',
    cat_group: 'income-group',
    is_income: 1,
  });
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertAccount({ id: 'savings', name: 'Savings' });
  await db.insertAccount({ id: 'mortgage', name: 'Mortgage', offbudget: 1 });
  const shop = await db.insertPayee({ id: 'shop', name: 'Market' });
  const onBudgetTransfer = await db.insertPayee({
    id: 'to-savings',
    name: '',
    transfer_acct: 'savings',
  });
  const offBudgetTransfer = await db.insertPayee({
    id: 'to-mortgage',
    name: '',
    transfer_acct: 'mortgage',
  });
  return {
    groceries,
    paycheck,
    shop,
    onBudgetTransfer,
    offBudgetTransfer,
  };
}

describe('loadCategoryCandidates', () => {
  it('keeps uncategorized rows and off-budget transfers, and drops the rest', async () => {
    const { shop, onBudgetTransfer, offBudgetTransfer, groceries } =
      await seedBudget();

    const openId = await db.insertTransaction({
      account: 'checking',
      amount: -5000,
      payee: shop,
      date: '2026-02-01',
    });
    await db.insertTransaction({
      account: 'checking',
      amount: -2000,
      payee: shop,
      category: groceries,
      date: '2026-02-02',
    });
    await db.insertTransaction({
      account: 'checking',
      amount: -3000,
      payee: shop,
      reconciled: true,
      date: '2026-02-03',
    });
    await db.insertTransaction({
      account: 'checking',
      amount: 100000,
      payee: shop,
      starting_balance_flag: true,
      date: '2026-02-04',
    });
    await db.insertTransaction({
      account: 'checking',
      amount: -4000,
      payee: onBudgetTransfer,
      date: '2026-02-05',
    });
    const offBudgetId = await db.insertTransaction({
      account: 'checking',
      amount: -8000,
      payee: offBudgetTransfer,
      date: '2026-02-06',
    });
    await db.insertTransaction({
      account: 'checking',
      amount: -9000,
      payee: shop,
      is_parent: true,
      date: '2026-02-07',
    });
    const otherAccountId = await db.insertTransaction({
      account: 'savings',
      amount: -1500,
      payee: shop,
      date: '2026-02-08',
    });

    const all = await loadCategoryCandidates();
    expect(all.map(row => row.id).sort()).toEqual(
      [openId, offBudgetId, otherAccountId].sort(),
    );

    const checking = await loadCategoryCandidates({ accountId: 'checking' });
    expect(checking.map(row => row.id).sort()).toEqual(
      [openId, offBudgetId].sort(),
    );
    expect(checking.find(row => row.id === offBudgetId)?.payee).toBe(
      'Mortgage',
    );

    const savings = await loadCategoryCandidates({ accountId: 'savings' });
    expect(savings).toHaveLength(1);
    expect(savings[0].payee).toBe('Market');
  });
});

describe('applyCategoryProposals', () => {
  it('writes an accepted category and refuses transfers, income-on-outflow, and unknown categories', async () => {
    const { shop, onBudgetTransfer, groceries, paycheck } = await seedBudget();

    const openId = await db.insertTransaction({
      account: 'checking',
      amount: -5000,
      payee: shop,
      date: '2026-03-01',
    });
    const transferId = await db.insertTransaction({
      account: 'checking',
      amount: -4000,
      payee: onBudgetTransfer,
      date: '2026-03-02',
    });
    const inflowId = await db.insertTransaction({
      account: 'checking',
      amount: 12000,
      payee: shop,
      date: '2026-03-03',
    });

    const refused = await applyCategoryProposals([
      { transactionId: openId, categoryId: paycheck },
      { transactionId: transferId, categoryId: groceries },
      { transactionId: 'missing', categoryId: groceries },
      { transactionId: inflowId, categoryId: 'not-a-category' },
    ]);
    expect(refused).toEqual({ applied: 0, skipped: 4, errors: [] });

    const unchanged = await db.getTransaction(openId);
    expect(unchanged.category).toBeFalsy();

    const applied = await applyCategoryProposals([
      { transactionId: openId, categoryId: groceries },
      { transactionId: inflowId, categoryId: paycheck },
    ]);
    expect(applied.applied).toBe(2);
    expect(applied.errors).toEqual([]);

    expect((await db.getTransaction(openId)).category).toBe(groceries);
    expect((await db.getTransaction(inflowId)).category).toBe(paycheck);

    const second = await applyCategoryProposals([
      { transactionId: openId, categoryId: groceries },
    ]);
    expect(second).toEqual({ applied: 0, skipped: 1, errors: [] });
  });
});
