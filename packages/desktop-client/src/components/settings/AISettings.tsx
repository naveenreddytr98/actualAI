import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Link } from '#components/common/Link';
import { Checkbox } from '#components/forms';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { pushModal } from '#modals/modalsSlice';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

import { Setting } from './UI';

type SuggestedCategory = {
  name: string;
  group: string;
  reason: string;
  exampleTransactions: string[];
};

type SuggestCategoriesResult = {
  suggestions: SuggestedCategory[];
  errors: string[];
  scanned: number;
};

export function AISettings() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [savedApiKey, setApiKey] = useGlobalPref('anthropicApiKey');
  const [draftKey, setDraftKey] = useState(savedApiKey ?? '');
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] =
    useState<SuggestCategoriesResult | null>(null);
  const [selectedPicks, setSelectedPicks] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  const dirty = (draftKey ?? '') !== (savedApiKey ?? '');

  function onSave() {
    setApiKey(draftKey.trim());
    dispatch(
      addNotification({
        notification: {
          type: 'message',
          message: t('Anthropic API key saved'),
        },
      }),
    );
  }

  function errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      return String(err.message);
    }
    return String(err);
  }

  async function onTest() {
    setTesting(true);
    try {
      const res = await send('ai-test-api-key');
      if (res.ok) {
        dispatch(
          addNotification({
            notification: {
              type: 'message',
              message: t('API key works'),
            },
          }),
        );
      } else {
        dispatch(
          addNotification({
            notification: {
              type: 'error',
              title: t('API key check failed'),
              message: res.error ?? t('Unknown error'),
            },
          }),
        );
      }
    } catch (err) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            title: t('API key check failed'),
            message: errorMessage(err),
          },
        }),
      );
    } finally {
      setTesting(false);
    }
  }

  function onReview() {
    dispatch(
      pushModal({
        modal: {
          name: 'ai-category-review',
          options: {},
        },
      }),
    );
  }

  async function onSuggest() {
    setSuggesting(true);
    setSuggestions(null);
    setSelectedPicks(new Set());
    try {
      const res = await send('ai-suggest-categories');
      setSuggestions(res);
      // Default to "all selected" so the common path is one click to create.
      setSelectedPicks(new Set(res.suggestions.map((_, i) => i)));
      if (res.errors.length > 0) {
        dispatch(
          addNotification({
            notification: {
              type: 'error',
              title: t('Suggesting categories failed'),
              message: res.errors.join('\n'),
              sticky: true,
            },
          }),
        );
      }
    } catch (err) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            title: t('Suggesting categories failed'),
            message: errorMessage(err),
            sticky: true,
          },
        }),
      );
    } finally {
      setSuggesting(false);
    }
  }

  function togglePick(i: number) {
    setSelectedPicks(prev => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  }

  async function onCreate() {
    if (!suggestions || selectedPicks.size === 0) return;
    const picks = suggestions.suggestions
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => selectedPicks.has(i))
      .map(({ s }) => ({ name: s.name, group: s.group }));

    setCreating(true);
    try {
      const res = await send('ai-create-categories', { picks });
      const summary = t(
        'Created {{created}} categories ({{skipped}} skipped). Use Undo to revert.',
        { created: res.created.length, skipped: res.skipped.length },
      );
      dispatch(
        addNotification({
          notification: {
            type: res.errors.length > 0 ? 'error' : 'message',
            title: res.errors.length > 0 ? t('Some errors') : undefined,
            message:
              res.errors.length > 0
                ? `${summary}\n${res.errors.join('\n')}`
                : summary,
            sticky: res.errors.length > 0,
          },
        }),
      );
      // Drop just the ones we successfully created so the user sees what's left.
      const createdNames = new Set(res.created.map(c => c.name.toLowerCase()));
      setSuggestions(prev =>
        prev
          ? {
              ...prev,
              suggestions: prev.suggestions.filter(
                s => !createdNames.has(s.name.toLowerCase()),
              ),
            }
          : prev,
      );
      setSelectedPicks(new Set());
    } finally {
      setCreating(false);
    }
  }

  const hasKey = Boolean(savedApiKey);

  return (
    <Setting
      primaryAction={
        <View style={{ gap: 12, width: '100%' }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Input
              type={revealed ? 'text' : 'password'}
              value={draftKey ?? ''}
              placeholder="sk-ant-..."
              onChange={e => setDraftKey(e.currentTarget.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <Button
              variant="bare"
              onPress={() => setRevealed(r => !r)}
              aria-label={revealed ? t('Hide key') : t('Show key')}
            >
              {revealed ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
            </Button>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              onPress={onSave}
              isDisabled={!dirty || draftKey.trim().length === 0}
            >
              <Trans>Save key</Trans>
            </Button>
            <ButtonWithLoading
              isLoading={testing}
              isDisabled={!hasKey || dirty}
              onPress={onTest}
            >
              <Trans>Test key</Trans>
            </ButtonWithLoading>
            <Button isDisabled={!hasKey || dirty} onPress={onReview}>
              <Trans>Review uncategorized transactions</Trans>
            </Button>
            <ButtonWithLoading
              isLoading={suggesting}
              isDisabled={!hasKey || dirty}
              onPress={onSuggest}
            >
              <Trans>Suggest new categories</Trans>
            </ButtonWithLoading>
          </View>
          {suggestions && (
            <View
              style={{
                marginTop: 4,
                padding: 12,
                backgroundColor: theme.tableBackground,
                borderRadius: 4,
                border: '1px solid ' + theme.tableBorder,
                gap: 10,
              }}
            >
              <Text style={{ fontWeight: 600 }}>
                <Trans>
                  Reviewed {{ scanned: suggestions.scanned }} recent
                  transactions
                </Trans>
              </Text>
              {suggestions.suggestions.length === 0 ? (
                <Text style={{ color: theme.pageTextSubdued }}>
                  <Trans>
                    No new categories needed — your existing categories cover
                    the data well.
                  </Trans>
                </Text>
              ) : (
                <>
                  <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
                    <Trans>
                      Pick the ones you want and click "Create selected".
                      They'll appear in your Budget. Use Undo to revert.
                    </Trans>
                  </Text>
                  {suggestions.suggestions.map((s, i) => (
                    <View
                      key={i}
                      style={{
                        gap: 4,
                        paddingTop: 8,
                        borderTop:
                          i === 0 ? 'none' : '1px solid ' + theme.tableBorder,
                      }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          cursor: 'pointer',
                        }}
                      >
                        <Checkbox
                          checked={selectedPicks.has(i)}
                          onChange={() => togglePick(i)}
                        />
                        <Text style={{ fontWeight: 600 }}>
                          {s.name}{' '}
                          <Text style={{ color: theme.pageTextSubdued }}>
                            <Trans>(in {{ group: s.group }})</Trans>
                          </Text>
                        </Text>
                      </label>
                      <Text
                        style={{
                          color: theme.pageText,
                          fontSize: 13,
                          marginLeft: 26,
                        }}
                      >
                        {s.reason}
                      </Text>
                      {s.exampleTransactions.length > 0 && (
                        <Text
                          style={{
                            color: theme.pageTextSubdued,
                            fontSize: 12,
                            fontStyle: 'italic',
                            marginLeft: 26,
                          }}
                        >
                          <Trans>
                            Examples:{' '}
                            {{ examples: s.exampleTransactions.join(', ') }}
                          </Trans>
                        </Text>
                      )}
                    </View>
                  ))}
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: 8,
                      paddingTop: 10,
                      borderTop: '1px solid ' + theme.tableBorder,
                    }}
                  >
                    <ButtonWithLoading
                      variant="primary"
                      isLoading={creating}
                      isDisabled={selectedPicks.size === 0}
                      onPress={onCreate}
                    >
                      <Trans>
                        Create selected ({{ count: selectedPicks.size }})
                      </Trans>
                    </ButtonWithLoading>
                    <Button
                      variant="bare"
                      onPress={() =>
                        setSelectedPicks(
                          new Set(suggestions.suggestions.map((_, i) => i)),
                        )
                      }
                    >
                      <Trans>Select all</Trans>
                    </Button>
                    <Button
                      variant="bare"
                      onPress={() => setSelectedPicks(new Set())}
                    >
                      <Trans>Clear</Trans>
                    </Button>
                  </View>
                </>
              )}
            </View>
          )}
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>AI categorization</strong> sends the payee, amount, and date
          of uncategorized transactions to Anthropic. Notes and internal ids
          stay on this device. Your API key is stored locally and is never
          synced. Anthropic bills your account for each request.
        </Trans>
      </Text>
      <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
        <Trans>
          Review the suggestions before anything is saved. Get a key at{' '}
          <Link
            variant="external"
            to="https://console.anthropic.com/settings/keys"
            linkColor="purple"
          >
            console.anthropic.com
          </Link>
          .
        </Trans>
      </Text>
    </Setting>
  );
}
