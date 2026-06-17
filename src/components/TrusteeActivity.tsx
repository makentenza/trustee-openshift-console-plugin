import type { FC } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DocumentTitle,
  ListPageHeader,
  consoleFetchText,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Bullseye,
  Button,
  Card,
  CardBody,
  Flex,
  FlexItem,
  Label,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { SyncAltIcon } from '@patternfly/react-icons';
import { useKbsConfigs, useTrusteeConfigs, useTrusteeDefaultProject } from '../k8s/hooks';
import {
  KBS_POD_LABEL_KEY,
  KBS_POD_LABEL_VALUE,
  PodGVK,
  TRUSTEE_NAMESPACE,
} from '../k8s/resources';
import type { PodKind, TrusteeConfigKind } from '../k8s/types';
import { kindColor, kindLabel, parseKbsLog, type KbsLogEntry } from '../utils/kbsLog';
import { relativeTime } from '../utils/evidence';
import './trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';

const isReady = (tc?: TrusteeConfigKind): boolean =>
  !!tc &&
  (tc.status?.isReady === true ||
    (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));

const TrusteeActivity: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  useTrusteeDefaultProject();

  const [trusteeConfigs] = useTrusteeConfigs();
  const [kbsConfigs] = useKbsConfigs();
  const primaryTc = useMemo(
    () => trusteeConfigs.find((tc) => isReady(tc)) ?? trusteeConfigs[0],
    [trusteeConfigs],
  );
  const hubNs =
    primaryTc?.metadata?.namespace ?? kbsConfigs[0]?.metadata?.namespace ?? TRUSTEE_NAMESPACE;

  const [pods] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: PodGVK,
    namespace: hubNs,
    isList: true,
  });
  const kbsPod = useMemo(
    () =>
      (pods ?? []).find(
        (p) =>
          p.metadata?.labels?.[KBS_POD_LABEL_KEY] === KBS_POD_LABEL_VALUE &&
          p.status?.phase === 'Running',
      )?.metadata?.name,
    [pods],
  );

  const [entries, setEntries] = useState<KbsLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();

  const fetchLogs = useCallback(async () => {
    if (!kbsPod) return;
    setLoading(true);
    setError(undefined);
    try {
      const url = `/api/kubernetes/api/v1/namespaces/${hubNs}/pods/${kbsPod}/log?container=kbs&tailLines=5000`;
      const text = await consoleFetchText(url);
      setEntries(parseKbsLog(text).slice(-250).reverse());
      setFetchedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kbsPod, hubNs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLogs();
  }, [fetchLogs]);

  return (
    <>
      <DocumentTitle>{t('Attestation activity')}</DocumentTitle>
      <ListPageHeader title={t('Attestation activity')}>
        <Button
          variant="secondary"
          icon={<SyncAltIcon />}
          onClick={() => void fetchLogs()}
          isLoading={loading}
          isDisabled={loading || !kbsPod}
        >
          {t('Refresh')}
        </Button>
      </ListPageHeader>
      <PageSection>
        <Alert
          variant="info"
          isInline
          title={t('Live attestation activity from the Trustee KBS log')}
          className={`${PREFIX}__mb`}
        >
          {t(
            'Parsed from the KBS container log: calls to the KBS API (/kbs/…) and attestation-service events; unrelated traffic is filtered out. This is a cluster-level activity view, not a per-workload cryptographic proof — for that, use the evidence in Attestation status.',
          )}
        </Alert>

        {!kbsPod ? (
          <Card>
            <CardBody>
              <span className={`${PREFIX}__muted`}>
                {t('No running KBS pod found in {{ns}}.', { ns: hubNs })}
              </span>
            </CardBody>
          </Card>
        ) : error ? (
          <Alert variant="danger" isInline title={t('Could not read the KBS log')}>
            {error}
          </Alert>
        ) : loading && entries.length === 0 ? (
          <Bullseye>
            <Spinner aria-label={t('Loading')} />
          </Bullseye>
        ) : entries.length === 0 ? (
          <Card>
            <CardBody>
              <span className={`${PREFIX}__muted`}>
                {t(
                  'No attestation activity in the recent log. Attestation happens when a confidential workload boots and fetches a resource from Trustee.',
                )}
              </span>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <div className={`${PREFIX}__muted ${PREFIX}__mb`}>
                {t('{{count}} events from pod {{pod}}', { count: entries.length, pod: kbsPod })}
                {fetchedAt ? ` · ${relativeTime(fetchedAt)}` : ''}
              </div>
              <div className={`${PREFIX}__activity`}>
                {entries.map((e, i) => (
                  <Flex
                    key={i}
                    gap={{ default: 'gapSm' }}
                    alignItems={{ default: 'alignItemsFlexStart' }}
                    className={`${PREFIX}__activity-row`}
                  >
                    <FlexItem>
                      <span className={`${PREFIX}__mono ${PREFIX}__muted`}>
                        {e.timestamp ? e.timestamp.slice(11, 19) : '--:--:--'}
                      </span>
                    </FlexItem>
                    <FlexItem>
                      <Label color={kindColor(e)} isCompact>
                        {kindLabel(e)}
                        {e.status ? ` ${e.status}` : ''}
                      </Label>
                    </FlexItem>
                    <FlexItem grow={{ default: 'grow' }}>
                      <span className={`${PREFIX}__mono`}>
                        {e.path ? `${e.path}${e.clientIp ? ` — ${e.clientIp}` : ''}` : e.message}
                      </span>
                    </FlexItem>
                  </Flex>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </PageSection>
    </>
  );
};

export default TrusteeActivity;
