import type { FC } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleFetchText, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Content,
  Flex,
  FlexItem,
  Label,
  Spinner,
} from '@patternfly/react-core';
import { CheckCircleIcon, ExclamationTriangleIcon, SyncAltIcon } from '@patternfly/react-icons';
import { useKbsConfigs, useTrusteeConfigs } from '../k8s/hooks';
import {
  KBS_POD_LABEL_KEY,
  KBS_POD_LABEL_VALUE,
  PodGVK,
  TRUSTEE_NAMESPACE,
} from '../k8s/resources';
import type { PodKind, TrusteeConfigKind } from '../k8s/types';
import { parseKbsLog } from '../utils/kbsLog';
import { relativeTime } from '../utils/evidence';
import './trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';

const isReady = (tc?: TrusteeConfigKind): boolean =>
  !!tc &&
  (tc.status?.isReady === true ||
    (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));

// A client is "remote" if it isn't on this cluster's pod network (10.x) or
// loopback — i.e. it reached the KBS over the external Route/LoadBalancer. The
// console can't watch the remote pod, but the KBS log proves it attested here.
const isRemoteClient = (ip?: string): boolean =>
  !!ip && !ip.startsWith('10.') && ip !== '127.0.0.1' && !ip.startsWith('::1');

type RemoteSpoke = {
  clientIp: string;
  lastSeen?: string;
  attests: number;
  released: number;
  attestOk: boolean;
  attestDenied: boolean;
  resources: { path: string; released: boolean }[];
};

/**
 * Remote attestation feed for the hub topology: parses the Trustee KBS log and
 * surfaces confidential workloads in OTHER clusters that attested to this Trustee
 * (grouped by source) — the spoke side of hub-and-spoke that the console can't
 * watch directly.
 */
export const RemoteAttestations: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');

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

  const [spokes, setSpokes] = useState<RemoteSpoke[]>([]);
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
      const byIp = new Map<string, RemoteSpoke>();
      for (const e of parseKbsLog(text)) {
        if ((e.kind !== 'attest' && e.kind !== 'resource') || !isRemoteClient(e.clientIp)) continue;
        const ip = e.clientIp as string;
        const s =
          byIp.get(ip) ??
          ({
            clientIp: ip,
            attests: 0,
            released: 0,
            attestOk: false,
            attestDenied: false,
            resources: [],
          } as RemoteSpoke);
        if (!s.lastSeen || (e.timestamp ?? '') > s.lastSeen) s.lastSeen = e.timestamp;
        if (e.kind === 'attest') {
          s.attests += 1;
          if (e.status && e.status < 300) s.attestOk = true;
          else if (e.status === 401 || e.status === 403) s.attestDenied = true;
        } else if (e.kind === 'resource' && e.path) {
          const ok = !!e.status && e.status < 300;
          // The KBS only releases a resource after a valid attestation token, so a
          // released secret is itself proof the workload attested — even when the
          // one-time POST /attest line has already aged out of the log window.
          if (ok) {
            s.attestOk = true;
            s.released += 1;
          }
          const path = e.path.replace('/kbs/v0/resource/', '');
          if (!s.resources.some((r) => r.path === path)) s.resources.push({ path, released: ok });
        }
        byIp.set(ip, s);
      }
      setSpokes(
        Array.from(byIp.values()).sort((a, b) =>
          (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''),
        ),
      );
      setFetchedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kbsPod, hubNs]);

  useEffect(() => {
    // Fetch-on-mount of external data (the KBS log); setState happens after the
    // async resolves, not synchronously. Same pattern as TrusteeActivity.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLogs();
  }, [fetchLogs]);

  return (
    <Card className={`${PREFIX}__mt`}>
      <CardTitle>
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsCenter' }}
        >
          <FlexItem>{t('Remote attestations (from the KBS log)')}</FlexItem>
          <FlexItem>
            <Button
              variant="link"
              icon={<SyncAltIcon />}
              onClick={() => void fetchLogs()}
              isLoading={loading}
              isDisabled={loading || !kbsPod}
            >
              {t('Refresh')}
            </Button>
          </FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <Content component="small" className={`${PREFIX}__muted ${PREFIX}__mb`}>
          {t(
            'Confidential workloads in other clusters that attested to this Trustee, grouped by source — read from the KBS container log (the console cannot watch remote-cluster pods directly).',
          )}
        </Content>
        {error ? (
          <Alert variant="danger" isInline title={t('Could not read the KBS log')}>
            {error}
          </Alert>
        ) : loading && spokes.length === 0 ? (
          <Spinner size="md" aria-label={t('Loading')} />
        ) : spokes.length === 0 ? (
          <span className={`${PREFIX}__muted`}>
            {t(
              'No remote attestations in the recent log. A confidential workload in another cluster attests when it boots and fetches a resource from this Trustee over the external Route/LoadBalancer.',
            )}
          </span>
        ) : (
          <>
            {spokes.map((s) => (
              <Flex
                key={s.clientIp}
                alignItems={{ default: 'alignItemsFlexStart' }}
                gap={{ default: 'gapSm' }}
                className={`${PREFIX}__activity-row`}
              >
                <FlexItem>
                  {s.attestOk ? (
                    <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />
                  ) : (
                    <ExclamationTriangleIcon color="var(--pf-t--global--icon--color--status--warning--default)" />
                  )}
                </FlexItem>
                <FlexItem grow={{ default: 'grow' }}>
                  <div>
                    <strong>{t('Remote workload')}</strong>{' '}
                    <span className={`${PREFIX}__mono ${PREFIX}__muted`}>{s.clientIp}</span>{' '}
                    <Label
                      isCompact
                      color={s.attestOk ? 'green' : s.attestDenied ? 'red' : 'orange'}
                    >
                      {s.attestOk ? t('attested') : s.attestDenied ? t('rejected') : t('attesting')}
                    </Label>
                  </div>
                  <div className={`${PREFIX}__muted`}>
                    {s.released > 0
                      ? t('{{count}} secret(s) released', { count: s.released })
                      : t('{{count}} attestation request(s)', { count: s.attests })}
                    {s.lastSeen ? ` · ${relativeTime(s.lastSeen)}` : ''}
                  </div>
                  {s.resources.length > 0 && (
                    <div className={`${PREFIX}__mono`}>
                      {s.resources.map((r) => (
                        <div key={r.path}>
                          <Label isCompact color={r.released ? 'green' : 'orange'}>
                            {r.released ? t('released') : t('denied')}
                          </Label>{' '}
                          {r.path}
                        </div>
                      ))}
                    </div>
                  )}
                </FlexItem>
              </Flex>
            ))}
            {fetchedAt && (
              <Content component="small" className={`${PREFIX}__muted ${PREFIX}__mt`}>
                {relativeTime(fetchedAt)}
              </Content>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
};

export default RemoteAttestations;
