import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { Checkbox } from '#components/forms';
import { useCategories } from '#hooks/useCategories';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

type AICategoryReviewModalProps = Extract<
  ModalType,
  { name: 'ai-category-review' }
>['options'];

type Proposal = {
  transactionId: string;
  payee: string;
  amount: number;
  date: string;
  categoryId: string;
  categoryName: string;
  accepted: boolean;
};

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String(err.message);
  }
  return String(err);
}

export function AICategoryReviewModal({
  accountId,
}: AICategoryReviewModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const { data: categories } = useCategories();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [rows, setRows] = useState<Proposal[]>([]);

  const categoryNames = new Map<string, string>();
  const categoryOptions = (categories?.grouped ?? []).flatMap(group =>
    (group.categories ?? [])
      .filter(category => category.group === group.id && !category.hidden)
      .map(category => {
        categoryNames.set(category.id, category.name);
        return [category.id, `${group.name}: ${category.name}`] as const;
      }),
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await send('ai-propose-categories', {
          accountId,
        });
        if (cancelled) {
          return;
        }
        if (res.errors.length > 0 && res.proposals.length === 0) {
          setError(res.errors.join('\n'));
          setRows([]);
        } else {
          setRows(
            res.proposals.map(proposal => ({ ...proposal, accepted: true })),
          );
          setTruncated(res.truncated);
          if (res.errors.length > 0) {
            setError(res.errors.join('\n'));
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const acceptedCount = rows.filter(row => row.accepted).length;

  async function onApply(close: () => void) {
    const picks = rows
      .filter(row => row.accepted)
      .map(row => ({
        transactionId: row.transactionId,
        categoryId: row.categoryId,
      }));
    if (picks.length === 0) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const res = await send('ai-apply-category-proposals', { picks });
      if (res.errors.length > 0) {
        setError(res.errors.join('\n'));
        return;
      }
      if (res.applied === 0) {
        setError(
          t(
            'None of the selected categories could be saved. They may no longer be uncategorized.',
          ),
        );
        return;
      }
      dispatch(
        addNotification({
          notification: {
            type: 'message',
            message: t(
              'Categorized {{applied}} transactions ({{skipped}} skipped). Use Undo to revert.',
              { applied: res.applied, skipped: res.skipped },
            ),
          },
        }),
      );
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      name="ai-category-review"
      isLoading={loading}
      containerProps={{ style: { width: 760, maxWidth: '95vw' } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Review AI categories')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 12, maxHeight: '70vh' }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>
                Suggestions use the payee, amount, and date. Nothing is saved
                until you accept it. Uncheck a row to skip it.
              </Trans>
            </Text>
            {truncated && (
              <Text>
                <Trans>
                  This is the latest batch. Apply it, then review again for the
                  rest.
                </Trans>
              </Text>
            )}
            {error && (
              <Text style={{ color: theme.errorText, whiteSpace: 'pre-wrap' }}>
                {error}
              </Text>
            )}
            {!loading && rows.length === 0 && !error && (
              <Text>
                <Trans>No uncategorized transactions to review.</Trans>
              </Text>
            )}
            {rows.length > 0 && (
              <View style={{ overflowY: 'auto', gap: 8, paddingRight: 4 }}>
                {rows.map(row => (
                  <View
                    key={row.transactionId}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingTop: 8,
                      borderTop: '1px solid ' + theme.tableBorder,
                    }}
                  >
                    <Checkbox
                      checked={row.accepted}
                      aria-label={t('Accept {{payee}}', { payee: row.payee })}
                      onChange={() => {
                        setRows(current =>
                          current.map(item =>
                            item.transactionId === row.transactionId
                              ? { ...item, accepted: !item.accepted }
                              : item,
                          ),
                        );
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text>{row.payee}</Text>
                      <Text style={{ color: theme.pageTextSubdued }}>
                        {monthUtils.format(row.date, dateFormat)}
                      </Text>
                    </View>
                    <FinancialText style={{ width: 110, textAlign: 'right' }}>
                      {format(row.amount, 'financial')}
                    </FinancialText>
                    <Select
                      value={row.categoryId}
                      options={categoryOptions}
                      defaultLabel={row.categoryName}
                      onChange={categoryId => {
                        setRows(current =>
                          current.map(item =>
                            item.transactionId === row.transactionId
                              ? {
                                  ...item,
                                  categoryId,
                                  categoryName:
                                    categoryNames.get(categoryId) ??
                                    item.categoryName,
                                }
                              : item,
                          ),
                        );
                      }}
                    />
                  </View>
                ))}
              </View>
            )}
            {rows.length > 0 && (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <ButtonWithLoading
                  variant="primary"
                  isLoading={applying}
                  isDisabled={acceptedCount === 0}
                  onPress={() => {
                    void onApply(() => state.close());
                  }}
                >
                  <Trans>Accept selected ({{ count: acceptedCount }})</Trans>
                </ButtonWithLoading>
                <Button
                  variant="bare"
                  onPress={() => {
                    setRows(current =>
                      current.map(row => ({ ...row, accepted: true })),
                    );
                  }}
                >
                  <Trans>Select all</Trans>
                </Button>
                <Button
                  variant="bare"
                  onPress={() => {
                    setRows(current =>
                      current.map(row => ({ ...row, accepted: false })),
                    );
                  }}
                >
                  <Trans>Clear</Trans>
                </Button>
              </View>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
