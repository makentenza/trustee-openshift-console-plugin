import type { FC } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Button,
  Card,
  CardBody,
  CardTitle,
  ClipboardCopy,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
} from '@patternfly/react-core';
import {
  ConfigMapGVK,
  SHARED_INITDATA_DATA_KEY,
  SHARED_INITDATA_KBS_URL_KEY,
  SHARED_INITDATA_LABEL,
  SHARED_INITDATA_PCR8_KEY,
} from '../../k8s/resources';
import type { ConfigMapKind } from '../../k8s/types';
import { buildWorkloadPodYaml } from '../../utils/initdata';
import '../trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';

interface Props {
  /** Namespace where this TrusteeConfig (and its saved initdata ConfigMaps) live. */
  namespace: string;
}

const downloadYaml = (filename: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/yaml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/**
 * Lists the shared-initdata ConfigMaps saved in this namespace so a user can find a
 * previously-generated initdata and copy its cc_init_data annotation (or re-download
 * the pod YAML) without digging through ConfigMaps. Addresses issue #7: once initdata
 * is saved it must stay easy to retrieve for creating workloads later.
 */
export const SavedInitdataPanel: FC<Props> = ({ namespace }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');

  const [cms] = useK8sWatchResource<ConfigMapKind[]>(
    namespace
      ? {
          groupVersionKind: ConfigMapGVK,
          namespace,
          isList: true,
          selector: { matchLabels: { [SHARED_INITDATA_LABEL]: 'true' } },
        }
      : null,
  ) as [ConfigMapKind[] | undefined, boolean, unknown];

  const items = useMemo(
    () =>
      (cms ?? [])
        .map((cm) => ({
          name: cm.metadata?.name ?? '',
          annotation: cm.data?.[SHARED_INITDATA_DATA_KEY] ?? '',
          kbsUrl: cm.data?.[SHARED_INITDATA_KBS_URL_KEY] ?? '',
          pcr8: cm.data?.[SHARED_INITDATA_PCR8_KEY] ?? '',
        }))
        .filter((i) => i.name !== '' && i.annotation !== '')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [cms],
  );

  return (
    <Card>
      <CardTitle>{t('Saved initdata')}</CardTitle>
      <CardBody>
        {items.length === 0 ? (
          <span className={`${PREFIX}__muted`}>
            {t(
              'No saved initdata in this namespace yet. Generate above and select “Save to cluster (ConfigMap)” to keep it here for later.',
            )}
          </span>
        ) : (
          <>
            <p className={`${PREFIX}__muted ${PREFIX}__mb`}>
              {t(
                'Initdata you saved to this cluster. Expand one to copy its cc_init_data annotation for a confidential workload.',
              )}
            </p>
            {items.map((it) => (
              <ExpandableSection
                key={it.name}
                toggleText={it.kbsUrl ? `${it.name} — ${it.kbsUrl}` : it.name}
              >
                <DescriptionList isCompact className={`${PREFIX}__mb`}>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('ConfigMap')}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <ResourceLink
                        groupVersionKind={ConfigMapGVK}
                        name={it.name}
                        namespace={namespace}
                      />
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                  {it.kbsUrl !== '' && (
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('KBS URL')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
                          {it.kbsUrl}
                        </ClipboardCopy>
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  )}
                  {it.pcr8 !== '' && (
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('PCR8 measurement')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
                          {it.pcr8}
                        </ClipboardCopy>
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  )}
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('cc_init_data annotation')}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <ClipboardCopy
                        isReadOnly
                        isExpanded
                        variant="expansion"
                        hoverTip={t('Copy')}
                        clickTip={t('Copied')}
                      >
                        {it.annotation}
                      </ClipboardCopy>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                </DescriptionList>
                <Button
                  variant="secondary"
                  onClick={() => {
                    downloadYaml(
                      `initdata-${it.name}.yaml`,
                      buildWorkloadPodYaml({
                        source: it.name,
                        kbsUrl: it.kbsUrl,
                        pcr8: it.pcr8,
                        annotation: it.annotation,
                      }),
                    );
                  }}
                >
                  {t('Download pod YAML')}
                </Button>
              </ExpandableSection>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
};

export default SavedInitdataPanel;
