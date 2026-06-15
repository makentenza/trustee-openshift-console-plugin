import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom-v5-compat';
import { useTranslation } from 'react-i18next';
import {
  DocumentTitle,
  ListPageHeader,
  ResourceLink,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Bullseye,
  Card,
  CardBody,
  ClipboardCopy,
  Content,
  DataList,
  DataListCell,
  DataListContent,
  DataListItem,
  DataListItemCells,
  DataListItemRow,
  DataListToggle,
  Flex,
  FlexItem,
  Grid,
  GridItem,
  Label,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  OutlinedQuestionCircleIcon,
  TimesCircleIcon,
} from '@patternfly/react-icons';
import { useKbsConfigs, useTrusteeConfigs } from '../k8s/hooks';
import {
  ConfigMapGVK,
  EventGVK,
  NodeGVK,
  PodGVK,
  RVPS_REFERENCE_VALUES_KEY,
  RVPS_REFERENCE_VALUES_SUFFIX,
  TRUSTEE_NAMESPACE,
} from '../k8s/resources';
import type { ConfigMapKind, EventKind, NodeKind, PodKind, TrusteeConfigKind } from '../k8s/types';
import {
  baselineVerdict,
  buildAttestWorkloads,
  buildChecks,
  cdhProbeCommand,
  hasBlockingEvent,
  remediation,
  scanEvents,
  verdictColor,
  verdictLabel,
  type AttestContext,
  type AttestWorkload,
  type Check,
} from '../utils/attestation';
import { teeShort } from '../utils/topology';
import './trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';

const isReady = (tc?: TrusteeConfigKind): boolean =>
  !!tc &&
  (tc.status?.isReady === true ||
    (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));

const referenceValuesPresent = (cms: ConfigMapKind[]): boolean =>
  cms.some((cm) => {
    if (!cm.metadata?.name?.endsWith(RVPS_REFERENCE_VALUES_SUFFIX)) return false;
    const raw = cm.data?.[RVPS_REFERENCE_VALUES_KEY];
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
      return false;
    } catch {
      return raw.trim().length > 2;
    }
  });

const CheckRowIcon: FC<{ state: Check['state'] }> = ({ state }) => {
  if (state === 'ok') return <CheckCircleIcon className={`${PREFIX}__icon-success`} />;
  if (state === 'warn') return <ExclamationTriangleIcon className={`${PREFIX}__icon-warning`} />;
  if (state === 'fail') return <TimesCircleIcon className={`${PREFIX}__icon-danger`} />;
  return <OutlinedQuestionCircleIcon className={`${PREFIX}__icon-info`} />;
};

const StatTile: FC<{ value: number; label: string }> = ({ value, label }) => (
  <Card isCompact className={`${PREFIX}__stat`}>
    <CardBody>
      <div className={`${PREFIX}__stat-value`}>{value}</div>
      <div className={`${PREFIX}__stat-label`}>{label}</div>
    </CardBody>
  </Card>
);

const ProbeDetail: FC<{ w: AttestWorkload; ctx: AttestContext }> = ({ w, ctx }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [events] = useK8sWatchResource<EventKind[]>({
    groupVersionKind: EventGVK,
    namespace: w.namespace,
    isList: true,
    fieldSelector: `involvedObject.uid=${w.uid}`,
  });
  const probeEvents = useMemo(() => scanEvents(events ?? []), [events]);
  const blocking = hasBlockingEvent(probeEvents);
  const checks = buildChecks(w, ctx);
  const rems = remediation(w, ctx, blocking);

  return (
    <Grid hasGutter>
      <GridItem md={6}>
        <Content component="p">
          <strong>{t('Checks')}</strong>
        </Content>
        {checks.map((c) => (
          <Flex key={c.id} gap={{ default: 'gapSm' }} className={`${PREFIX}__mb`}>
            <FlexItem>
              <CheckRowIcon state={c.state} />
            </FlexItem>
            <FlexItem>
              <div>{c.label}</div>
              <div className={`${PREFIX}__muted`}>{c.detail}</div>
            </FlexItem>
          </Flex>
        ))}
        <Content component="p" className={`${PREFIX}__mt`}>
          <strong>{t('Recent events')}</strong>
        </Content>
        {probeEvents.length === 0 ? (
          <div className={`${PREFIX}__muted`}>
            {t('No warning or attestation-related events for this pod.')}
          </div>
        ) : (
          probeEvents.map((e, i) => (
            <div key={i} className={`${PREFIX}__mb`}>
              <Label color={e.type === 'Warning' ? 'red' : 'grey'} isCompact>
                {e.reason || e.type}
              </Label>{' '}
              <span className={`${PREFIX}__muted`}>{e.message}</span>
            </div>
          ))
        )}
      </GridItem>
      <GridItem md={6}>
        <Content component="p">
          <strong>{t('How to fix it')}</strong>
        </Content>
        {rems.map((r, i) => (
          <div key={i} className={`${PREFIX}__mb`}>
            <div>{r.text}</div>
            {r.cdhCommand ? (
              <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
                {cdhProbeCommand(w.namespace, w.name)}
              </ClipboardCopy>
            ) : r.href ? (
              <Link to={r.href}>{t('Open')}</Link>
            ) : null}
          </div>
        ))}
        <div className={`${PREFIX}__mt`}>
          <Link to={`/trustee/verify/${w.namespace}/${w.name}`}>
            {t('Open guided verification')}
          </Link>
        </div>
      </GridItem>
    </Grid>
  );
};

const TrusteeAttestation: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');

  const [trusteeConfigs, tcLoaded] = useTrusteeConfigs();
  const [kbsConfigs] = useKbsConfigs();
  const [pods, podsLoaded] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: PodGVK,
    isList: true,
  });
  const [nodes, nodesLoaded] = useK8sWatchResource<NodeKind[]>({
    groupVersionKind: NodeGVK,
    isList: true,
  });

  const primaryTc = useMemo(
    () => trusteeConfigs.find((tc) => isReady(tc)) ?? trusteeConfigs[0],
    [trusteeConfigs],
  );
  const hubNs =
    primaryTc?.metadata?.namespace ?? kbsConfigs[0]?.metadata?.namespace ?? TRUSTEE_NAMESPACE;
  const kbsReady = isReady(primaryTc) || (kbsConfigs[0]?.status?.isReady ?? false);

  const [cms] = useK8sWatchResource<ConfigMapKind[]>({
    groupVersionKind: ConfigMapGVK,
    namespace: hubNs,
    isList: true,
  });
  const refPresent = useMemo(() => referenceValuesPresent(cms ?? []), [cms]);

  const ctx: AttestContext = useMemo(
    () => ({ kbsReady, referenceValuesPresent: refPresent }),
    [kbsReady, refPresent],
  );
  const workloads = useMemo(() => buildAttestWorkloads(pods ?? [], nodes ?? []), [pods, nodes]);
  const rows = useMemo(
    () => workloads.map((w) => ({ w, verdict: baselineVerdict(w, ctx) })),
    [workloads, ctx],
  );

  const counts = useMemo(() => {
    const c = { total: rows.length, healthy: 0, failing: 0, noatt: 0 };
    rows.forEach(({ verdict }) => {
      if (verdict === 'healthy') c.healthy++;
      else if (verdict === 'failing') c.failing++;
      else if (verdict === 'no-attestation') c.noatt++;
    });
    return c;
  }, [rows]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loading = !tcLoaded || !podsLoaded || !nodesLoaded;

  return (
    <>
      <DocumentTitle>{t('Attestation status')}</DocumentTitle>
      <ListPageHeader title={t('Attestation status')} />
      <PageSection>
        {loading ? (
          <Bullseye>
            <Spinner aria-label={t('Loading')} />
          </Bullseye>
        ) : (
          <>
            {!kbsReady && (
              <Alert
                variant="danger"
                isInline
                title={t('Trustee KBS is not ready — confidential workloads cannot attest')}
                className={`${PREFIX}__mb`}
              >
                <Link to="/trustee">{t('Check Trustee status')}</Link>
              </Alert>
            )}
            {kbsReady && !refPresent && (
              <Alert
                variant="warning"
                isInline
                title={t('No attestation reference values are registered')}
                className={`${PREFIX}__mb`}
              >
                {t(
                  'Trustee rejects attestation until reference values (RVPS) are registered. Generate them from a TrusteeConfig, or add the PCR8 a workload’s initdata produces.',
                )}{' '}
                <Link to="/trustee">{t('Open Confidential Attestation')}</Link>
              </Alert>
            )}

            <Grid hasGutter className={`${PREFIX}__mb`}>
              <GridItem span={3}>
                <StatTile value={counts.total} label={t('Confidential workloads')} />
              </GridItem>
              <GridItem span={3}>
                <StatTile value={counts.healthy} label={t('Healthy')} />
              </GridItem>
              <GridItem span={3}>
                <StatTile value={counts.failing} label={t('Failing')} />
              </GridItem>
              <GridItem span={3}>
                <StatTile value={counts.noatt} label={t('Not attesting')} />
              </GridItem>
            </Grid>

            {rows.length === 0 ? (
              <Card>
                <CardBody>
                  <span className={`${PREFIX}__muted`}>
                    {t(
                      'No confidential workloads found in this cluster. Deploy a pod on the kata-cc runtime to see its attestation status here.',
                    )}
                  </span>
                </CardBody>
              </Card>
            ) : (
              <DataList aria-label={t('Confidential workload attestation status')}>
                {rows.map(({ w, verdict }) => {
                  const open = expanded.has(w.uid);
                  return (
                    <DataListItem key={w.uid} isExpanded={open}>
                      <DataListItemRow>
                        <DataListToggle
                          id={`toggle-${w.uid}`}
                          isExpanded={open}
                          onClick={() => toggle(w.uid)}
                          aria-label={t('Probe attestation')}
                        />
                        <DataListItemCells
                          dataListCells={[
                            <DataListCell key="wl" width={2}>
                              <ResourceLink
                                groupVersionKind={PodGVK}
                                name={w.name}
                                namespace={w.namespace}
                                inline
                              />
                              <div className={`${PREFIX}__muted`}>
                                {w.runtime}
                                {w.gpu ? ' · GPU' : ''}
                              </div>
                            </DataListCell>,
                            <DataListCell key="node">
                              {w.nodeName ? (
                                <>
                                  {w.nodeName}
                                  {teeShort(w.tee) ? ` · ${teeShort(w.tee)}` : ''}
                                </>
                              ) : (
                                <span className={`${PREFIX}__muted`}>{t('unscheduled')}</span>
                              )}
                            </DataListCell>,
                            <DataListCell key="init">
                              {w.hasInitData ? (
                                <Label color="blue" isCompact>
                                  {t('initdata')}
                                </Label>
                              ) : (
                                <Label color="orange" isCompact>
                                  {t('no initdata')}
                                </Label>
                              )}
                            </DataListCell>,
                            <DataListCell key="verdict">
                              <Label color={verdictColor(verdict)}>{verdictLabel(verdict)}</Label>
                            </DataListCell>,
                          ]}
                        />
                      </DataListItemRow>
                      <DataListContent
                        aria-label={t('Attestation probe for {{name}}', { name: w.name })}
                        isHidden={!open}
                      >
                        {open && <ProbeDetail w={w} ctx={ctx} />}
                      </DataListContent>
                    </DataListItem>
                  );
                })}
              </DataList>
            )}
          </>
        )}
      </PageSection>
    </>
  );
};

export default TrusteeAttestation;
