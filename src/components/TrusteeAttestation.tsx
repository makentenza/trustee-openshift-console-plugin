import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
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
  Button,
  Card,
  CardBody,
  CardTitle,
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
  LockIcon,
  OutlinedQuestionCircleIcon,
  TimesCircleIcon,
} from '@patternfly/react-icons';
import { useKbsConfigs, useTrusteeConfigs, useTrusteeDefaultProject } from '../k8s/hooks';
import {
  ConfigMapGVK,
  EventGVK,
  NodeGVK,
  PodGVK,
  RVPS_REFERENCE_VALUES_KEY,
  RVPS_REFERENCE_VALUES_SUFFIX,
  TRUSTEE_NAMESPACE,
  TrusteeConfigModelRef,
} from '../k8s/resources';
import type { ConfigMapKind, EventKind, NodeKind, PodKind, TrusteeConfigKind } from '../k8s/types';
import {
  baselineVerdict,
  buildAttestWorkloads,
  buildChecks,
  hasBlockingEvent,
  remediation,
  scanEvents,
  verdictColor,
  verdictLabel,
  type AttestContext,
  type AttestWorkload,
  type Check,
  type Verdict,
} from '../utils/attestation';
import { teeShort } from '../utils/topology';
import {
  decodeJwt,
  evidenceKey,
  parseEvidence,
  relativeTime,
  type EvidenceRecord,
} from '../utils/evidence';
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

const StatTile: FC<{ value: number; label: string; onClick?: () => void; active?: boolean }> = ({
  value,
  label,
  onClick,
  active,
}) => (
  <Card
    isCompact
    onClick={onClick}
    className={`${PREFIX}__stat${onClick ? ` ${PREFIX}__stat--clickable` : ''}${
      active ? ` ${PREFIX}__stat--active` : ''
    }`}
  >
    <CardBody>
      <div className={`${PREFIX}__stat-value`}>{value}</div>
      <div className={`${PREFIX}__stat-label`}>{label}</div>
    </CardBody>
  </Card>
);

const ProbeDetail: FC<{
  w: AttestWorkload;
  ctx: AttestContext;
  links: { referenceValues: string; health: string };
  evidence?: EvidenceRecord;
}> = ({ w, ctx, links, evidence }) => {
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
  const rems = remediation(w, ctx, blocking, links);

  const decoded = decodeJwt(evidence?.token);
  return (
    <>
      {evidence && (
        <Alert
          variant={
            evidence.verdict === 'passed'
              ? 'success'
              : evidence.verdict === 'failed'
                ? 'danger'
                : 'warning'
          }
          isInline
          title={`${t('Collected evidence')} (${evidence.source ?? 'probe'}) · ${
            evidence.verdict ?? ''
          } · ${relativeTime(evidence.timestamp)}`}
          className={`${PREFIX}__mb`}
        >
          <div className={`${PREFIX}__muted`}>
            {evidence.probe?.method}
            {evidence.probe?.cdhPath ? ` · ${evidence.probe.cdhPath}` : ''}
            {evidence.probe?.httpStatus && evidence.probe.httpStatus !== '000'
              ? ` · HTTP ${evidence.probe.httpStatus}`
              : ''}
          </div>
          {decoded ? (
            <div className={`${PREFIX}__mt`}>
              <div className={`${PREFIX}__muted`}>{t('Attestation token claims (EAR)')}</div>
              <ClipboardCopy
                isCode
                isReadOnly
                isExpanded
                variant="expansion"
                hoverTip={t('Copy')}
                clickTip={t('Copied')}
              >
                {JSON.stringify(decoded.payload, null, 2)}
              </ClipboardCopy>
            </div>
          ) : null}
        </Alert>
      )}
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
          {rems
            .filter((r) => !r.cdhCommand)
            .map((r, i) => (
              <div key={i} className={`${PREFIX}__mb`}>
                <div>{r.text}</div>
                {r.href ? <Link to={r.href}>{t('Open')}</Link> : null}
              </div>
            ))}
          <Alert
            variant="info"
            isInline
            isPlain
            title={t('Confirming attestation')}
            className={`${PREFIX}__mt`}
          >
            <Content component="p" className={`${PREFIX}__muted`}>
              {t(
                'A confidential guest is sealed — the console cannot exec into it to probe. Deploy the workload with the self-reporting attestation evidence sidecar; it fetches a secret from the in-guest Confidential Data Hub (released only after a successful attestation) and publishes a verifiable evidence record that appears here automatically.',
              )}
            </Content>
          </Alert>
        </GridItem>
      </Grid>
    </>
  );
};

const TrusteeAttestation: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  useTrusteeDefaultProject();

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
  const tcBase =
    primaryTc?.metadata?.namespace && primaryTc?.metadata?.name
      ? `/k8s/ns/${primaryTc.metadata.namespace}/${TrusteeConfigModelRef}/${primaryTc.metadata.name}`
      : undefined;
  const refValuesPath = tcBase ? `${tcBase}/reference-values` : '/trustee';
  const healthPath = tcBase ? `${tcBase}/health` : '/trustee';
  const tabLinks = { referenceValues: refValuesPath, health: healthPath };

  // Watch the operator's RVPS ConfigMap by name — a named watch returns the full
  // .data, whereas a ConfigMap list watch may omit it (hence false "no ref values").
  const rvpsCmName = primaryTc?.metadata?.name
    ? `${primaryTc.metadata.name}${RVPS_REFERENCE_VALUES_SUFFIX}`
    : undefined;
  const [rvpsCm] = useK8sWatchResource<ConfigMapKind>(
    rvpsCmName ? { groupVersionKind: ConfigMapGVK, name: rvpsCmName, namespace: hubNs } : null,
  ) as [ConfigMapKind | undefined, boolean, unknown];
  const refPresent = useMemo(() => referenceValuesPresent(rvpsCm ? [rvpsCm] : []), [rvpsCm]);

  const [evidenceCms] = useK8sWatchResource<ConfigMapKind[]>({
    groupVersionKind: ConfigMapGVK,
    isList: true,
    selector: { matchLabels: { 'trustee.attestation/evidence': 'true' } },
  });
  const evidenceByKey = useMemo(() => {
    const m = new Map<string, EvidenceRecord>();
    (evidenceCms ?? []).forEach((cm) => {
      const rec = parseEvidence(cm.data?.['evidence.json']);
      const key = evidenceKey(rec);
      if (rec && key && (rec.timestamp ?? '') >= (m.get(key)?.timestamp ?? '')) m.set(key, rec);
    });
    return m;
  }, [evidenceCms]);

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
  const [filter, setFilter] = useState<Verdict | 'all'>('all');
  const toggleFilter = (v: Verdict) => setFilter((f) => (f === v ? 'all' : v));
  const visibleRows = filter === 'all' ? rows : rows.filter((r) => r.verdict === filter);

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
        ) : trusteeConfigs.length === 0 ? (
          <Card isLarge>
            <CardTitle>
              <LockIcon /> {t('No Trustee deployment found')}
            </CardTitle>
            <CardBody>
              <p className={`${PREFIX}__mb`}>
                {t(
                  'Deploy Trustee to start attesting confidential workloads — one TrusteeConfig generates the KBS, policies, reference values, and secrets.',
                )}
              </p>
              <Button
                variant="primary"
                component={(props) => <Link {...props} to="/trustee/setup" />}
              >
                {t('Go to Setup')}
              </Button>
            </CardBody>
          </Card>
        ) : (
          <>
            {!kbsReady && (
              <Alert
                variant="danger"
                isInline
                title={t('Trustee KBS is not ready — confidential workloads cannot attest')}
                className={`${PREFIX}__mb`}
              >
                <Link to={healthPath}>{t('Check Trustee health')}</Link>
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
                <Link to={refValuesPath}>{t('Open reference values')}</Link>
              </Alert>
            )}

            <Grid hasGutter className={`${PREFIX}__mb`}>
              <GridItem span={3}>
                <StatTile
                  value={counts.total}
                  label={t('Confidential workloads')}
                  onClick={() => setFilter('all')}
                  active={filter === 'all'}
                />
              </GridItem>
              <GridItem span={3}>
                <StatTile
                  value={counts.healthy}
                  label={t('Healthy')}
                  onClick={() => toggleFilter('healthy')}
                  active={filter === 'healthy'}
                />
              </GridItem>
              <GridItem span={3}>
                <StatTile
                  value={counts.failing}
                  label={t('Failing')}
                  onClick={() => toggleFilter('failing')}
                  active={filter === 'failing'}
                />
              </GridItem>
              <GridItem span={3}>
                <StatTile
                  value={counts.noatt}
                  label={t('Not attesting')}
                  onClick={() => toggleFilter('no-attestation')}
                  active={filter === 'no-attestation'}
                />
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
            ) : visibleRows.length === 0 ? (
              <Card>
                <CardBody>
                  <span className={`${PREFIX}__muted`}>{t('No workloads match this filter.')}</span>
                </CardBody>
              </Card>
            ) : (
              <DataList aria-label={t('Confidential workload attestation status')}>
                {visibleRows.map(({ w, verdict }) => {
                  const open = expanded.has(w.uid);
                  const ev = evidenceByKey.get(`${w.namespace}/${w.name}`);
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
                            <DataListCell key="evidence">
                              {ev ? (
                                <Label
                                  color={
                                    ev.verdict === 'passed'
                                      ? 'green'
                                      : ev.verdict === 'failed'
                                        ? 'red'
                                        : 'grey'
                                  }
                                  isCompact
                                >
                                  {ev.source === 'sidecar' ? t('live') : t('evidence')} ·{' '}
                                  {ev.verdict} · {relativeTime(ev.timestamp)}
                                </Label>
                              ) : (
                                <span className={`${PREFIX}__muted`}>{t('none')}</span>
                              )}
                            </DataListCell>,
                          ]}
                        />
                      </DataListItemRow>
                      <DataListContent
                        aria-label={t('Attestation probe for {{name}}', { name: w.name })}
                        isHidden={!open}
                      >
                        {open && <ProbeDetail w={w} ctx={ctx} links={tabLinks} evidence={ev} />}
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
