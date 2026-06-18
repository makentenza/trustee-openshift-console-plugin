import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, k8sPatch, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Flex,
  FlexItem,
  FormSelect,
  FormSelectOption,
  Spinner,
  TextArea,
} from '@patternfly/react-core';
import { ConfigMapGVK, ConfigMapModel } from '../../k8s/resources';
import type { ConfigMapKind } from '../../k8s/types';
import '../trustee.css';

interface Props {
  namespace: string;
  configMapName: string;
  title: string;
  description?: string;
  /** Pin which data key to edit; otherwise the first key is used. */
  preferredKey?: string;
  /** Optional starter templates: buttons that populate the editor. */
  templates?: { id: string; label: string; value: string }[];
  /**
   * Optional content validator run before save (and live for the inline error).
   * Returns an error message to block the patch, or undefined when valid.
   */
  validate?: (draft: string) => string | undefined;
}

/**
 * Loads an operator-generated ConfigMap (a Rego policy or the RVPS reference
 * values) and lets the user edit one of its data keys, saving with a JSON patch.
 * Read-only in effect when the user lacks update access — the patch fails and the
 * error is surfaced.
 */
const ConfigMapEditor: FC<Props> = ({
  namespace,
  configMapName,
  title,
  description,
  preferredKey,
  templates,
  validate,
}) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [configMap, loaded, loadError] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    name: configMapName,
    namespace,
  }) as [ConfigMapKind | undefined, boolean, unknown];

  // A named ConfigMap that doesn't exist yet 404s: `loaded` never flips true, only
  // loadError is set. Gate on settled (loaded OR errored) so the spinner doesn't
  // spin forever and the "not found" alert below is actually reachable.
  const settled = loaded || Boolean(loadError);

  const keys = useMemo(() => Object.keys(configMap?.data ?? {}), [configMap]);
  const [activeKey, setActiveKey] = useState('');
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [syncToken, setSyncToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const resolvedKey =
    activeKey && keys.includes(activeKey)
      ? activeKey
      : preferredKey && keys.includes(preferredKey)
        ? preferredKey
        : (keys[0] ?? '');

  // Render-phase sync: reset the draft when the ConfigMap/key changes and there
  // are no unsaved edits (React's recommended alternative to setState-in-effect).
  const token = `${configMap?.metadata?.resourceVersion ?? ''}:${resolvedKey}`;
  if (loaded && resolvedKey && !dirty && token !== syncToken) {
    setDraft(configMap?.data?.[resolvedKey] ?? '');
    setSyncToken(token);
  }

  // Live validation error (when a validator is provided) — drives the inline
  // message and disables Save so an invalid policy is never patched.
  const validationError = validate && dirty ? validate(draft) : undefined;

  const onSave = async () => {
    if (!configMap) return;
    if (validate) {
      const err = validate(draft);
      if (err) {
        setSaveError(err);
        return;
      }
    }
    setSaving(true);
    setSaveError('');
    try {
      const hasData = Boolean(configMap.data);
      await k8sPatch<ConfigMapKind>({
        model: ConfigMapModel,
        resource: configMap,
        data: [
          {
            op: hasData ? 'replace' : 'add',
            path: hasData ? `/data/${resolvedKey.replace(/\//g, '~1')}` : '/data',
            value: hasData ? draft : { [resolvedKey]: draft },
          },
        ],
      });
      setDirty(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <CardBody>
        {description && (
          <p className="trustee-openshift-console-plugin__muted trustee-openshift-console-plugin__mb">
            {description}
          </p>
        )}
        <p className="trustee-openshift-console-plugin__mb">
          {/* Only link when the ConfigMap actually exists — otherwise the link
              navigates to a non-existent resource and the console 404s. */}
          {configMap ? (
            <ResourceLink
              groupVersionKind={ConfigMapGVK}
              name={configMapName}
              namespace={namespace}
            />
          ) : (
            <span className="trustee-openshift-console-plugin__mono">{configMapName}</span>
          )}
        </p>
        {!settled ? (
          <Spinner size="md" aria-label={t('Loading')} />
        ) : loadError ? (
          <Alert variant="warning" isInline title={t('ConfigMap could not be loaded')}>
            {t(
              'The ConfigMap "{{name}}" was not found in namespace "{{namespace}}". It is generated by the Trustee operator from the TrusteeConfig.',
              { name: configMapName, namespace },
            )}
          </Alert>
        ) : keys.length === 0 ? (
          <Alert variant="info" isInline title={t('ConfigMap has no data keys')} />
        ) : (
          <>
            {keys.length > 1 && (
              <FormSelect
                value={resolvedKey}
                aria-label={t('Select key')}
                onChange={(_e, value) => {
                  setActiveKey(value);
                  setDirty(false);
                }}
                className="trustee-openshift-console-plugin__mb"
              >
                {keys.map((k) => (
                  <FormSelectOption key={k} value={k} label={k} />
                ))}
              </FormSelect>
            )}
            {templates && templates.length > 0 && (
              <Flex
                gap={{ default: 'gapSm' }}
                alignItems={{ default: 'alignItemsCenter' }}
                className="trustee-openshift-console-plugin__mb"
              >
                <FlexItem>
                  <span className="trustee-openshift-console-plugin__muted">
                    {t('Start from a template:')}
                  </span>
                </FlexItem>
                {templates.map((tpl) => (
                  <FlexItem key={tpl.id}>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDraft(tpl.value);
                        setDirty(true);
                      }}
                    >
                      {tpl.label}
                    </Button>
                  </FlexItem>
                ))}
              </Flex>
            )}
            <TextArea
              value={draft}
              onChange={(_e, value) => {
                setDraft(value);
                setDirty(true);
              }}
              aria-label={`${title} ${resolvedKey}`}
              rows={16}
              resizeOrientation="vertical"
              style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}
            />
            {validationError && (
              <Alert
                variant="warning"
                isInline
                isPlain
                title={validationError}
                className="trustee-openshift-console-plugin__mt"
              />
            )}
            {saveError && (
              <Alert
                variant="danger"
                isInline
                title={t('Could not save')}
                className="trustee-openshift-console-plugin__mt"
              >
                {saveError}
              </Alert>
            )}
            <Flex className="trustee-openshift-console-plugin__mt">
              <FlexItem>
                <Button
                  variant="primary"
                  onClick={() => void onSave()}
                  isDisabled={!dirty || saving || Boolean(validationError)}
                  isLoading={saving}
                >
                  {t('Save')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="link"
                  isDisabled={!dirty || saving}
                  onClick={() => {
                    setDraft(configMap?.data?.[resolvedKey] ?? '');
                    setDirty(false);
                  }}
                >
                  {t('Reset')}
                </Button>
              </FlexItem>
            </Flex>
          </>
        )}
      </CardBody>
    </Card>
  );
};

export default ConfigMapEditor;
