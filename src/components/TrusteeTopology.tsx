import type { FC } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  DocumentTitle,
  ListPageHeader,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Bullseye,
  Button,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { LockIcon, SyncAltIcon } from '@patternfly/react-icons';
import {
  useKbsConfigs,
  useRemoteAttestations,
  useTrusteeConfigs,
  useTrusteeDefaultProject,
  type RemoteSpoke,
} from '../k8s/hooks';
import {
  CC_INIT_DATA_ANNOTATION,
  ConfigMapGVK,
  InfrastructureGVK,
  KBS_SERVICE_NAME,
  KBS_SERVICE_PORT,
  NodeGVK,
  OSC_NAMESPACE,
  PEER_PODS_CM,
  PodGVK,
  RouteGVK,
  TRUSTEE_NAMESPACE,
} from '../k8s/resources';
import type {
  ConfigMapKind,
  InfrastructureKind,
  NodeKind,
  PodKind,
  RouteKind,
  TrusteeConfigKind,
} from '../k8s/types';
import {
  buildTopoCluster,
  classifyKbsUrl,
  cvmPeerPodsEnabled,
  decodeInitdataKbsUrl,
  isConfidentialRuntimeName,
  layoutTopology,
  SPOKE_ROW_H,
  teeLong,
  teeShort,
  truncate,
  type AttestInfo,
  type LaidNode,
  type LaidWorkload,
  type WlStatus,
} from '../utils/topology';
import { relativeTime } from '../utils/evidence';
import './trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';
const SETUP = '/trustee/setup';

const isReady = (tc?: TrusteeConfigKind): boolean =>
  !!tc &&
  (tc.status?.isReady === true ||
    (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));

const dotClass = (s: WlStatus): string => `${PREFIX}__topo-dot--${s}`;

const EmptyTrustee: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  return (
    <EmptyState headingLevel="h4" icon={LockIcon} titleText={t('No Trustee deployment found')}>
      <EmptyStateBody>
        {t(
          'The attestation topology shows the confidential workloads a Trustee attests, grouped by the node and cluster they run in. Create a TrusteeConfig to deploy Trustee, then return here.',
        )}
      </EmptyStateBody>
      <EmptyStateFooter>
        <EmptyStateActions>
          <Link to={SETUP}>
            <Button variant="primary">{t('Create TrusteeConfig')}</Button>
          </Link>
        </EmptyStateActions>
      </EmptyStateFooter>
    </EmptyState>
  );
};

const LegendDot: FC<{ variant: string; label: string }> = ({ variant, label }) => (
  <span className={`${PREFIX}__legend-item`}>
    <span className={`${PREFIX}__legend-dot ${PREFIX}__legend-dot--${variant}`} />
    {label}
  </span>
);

const TrusteeTopology: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const navigate = useNavigate();
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
  // Peer-pods config — decides whether kata-remote (cloud) workloads are confidential.
  const [peerPodsCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: PEER_PODS_CM,
  });
  const cvmPeerPods = cvmPeerPodsEnabled(peerPodsCm?.data);
  const [infra] = useK8sWatchResource<InfrastructureKind[]>({
    groupVersionKind: InfrastructureGVK,
    isList: true,
  });

  const primaryTc = useMemo(
    () => trusteeConfigs.find((tc) => isReady(tc)) ?? trusteeConfigs[0],
    [trusteeConfigs],
  );
  const hubNs =
    primaryTc?.metadata?.namespace ?? kbsConfigs[0]?.metadata?.namespace ?? TRUSTEE_NAMESPACE;
  const hubReady = isReady(primaryTc) || (kbsConfigs[0]?.status?.isReady ?? false);
  const kbsEndpoint = `${KBS_SERVICE_NAME}.${hubNs}.svc:${KBS_SERVICE_PORT}`;

  // Decode each confidential pod's initdata KBS URL so the topology shows which
  // Trustee each workload ACTUALLY attests to (this one vs a remote hub) — not
  // merely where it runs.
  const [attestByUid, setAttestByUid] = useState<Map<string, AttestInfo>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map<string, AttestInfo>();
      for (const p of pods ?? []) {
        if (!isConfidentialRuntimeName(p.spec?.runtimeClassName, cvmPeerPods)) continue;
        const ann = p.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION];
        if (!ann) continue;
        const uid = p.metadata?.uid ?? `${p.metadata?.namespace ?? ''}/${p.metadata?.name ?? ''}`;
        const url = await decodeInitdataKbsUrl(ann);
        if (url) next.set(uid, classifyKbsUrl(url, KBS_SERVICE_NAME));
      }
      if (!cancelled) setAttestByUid(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [pods, cvmPeerPods]);

  // Remote spokes can't resolve the in-cluster Service DNS — they reach the KBS
  // over the network through its externally-exposed Route. Find the Route that
  // targets the KBS Service in the hub namespace.
  const [routes] = useK8sWatchResource<RouteKind[]>({
    groupVersionKind: RouteGVK,
    namespace: hubNs,
    isList: true,
  });
  const routeHost = useMemo(() => {
    const r = (routes ?? []).find((rt) => rt.spec?.to?.name === KBS_SERVICE_NAME);
    return r?.spec?.host ?? r?.status?.ingress?.[0]?.host ?? '';
  }, [routes]);
  const remoteEndpoint = routeHost ? `https://${routeHost}` : '';

  // Co-located confidential workloads hit the in-cluster KBS Service directly, so the
  // KBS access log records their own pod IP. Passing these lets remote-spoke detection
  // tell them apart from Route traffic (which arrives as the cluster router's IP).
  const localConfidentialPodIps = useMemo(
    () =>
      (pods ?? [])
        .filter((p) => isConfidentialRuntimeName(p.spec?.runtimeClassName, cvmPeerPods))
        .map((p) => p.status?.podIP)
        .filter(Boolean) as string[],
    [pods, cvmPeerPods],
  );

  // Remote confidential workloads (in other clusters) that attested to this
  // Trustee, read from the KBS log — the spoke side the console can't watch.
  const {
    spokes,
    loading: spokesLoading,
    error: spokesError,
    fetchedAt,
    refresh,
  } = useRemoteAttestations(hubNs, localConfidentialPodIps);

  const layout = useMemo(
    () =>
      layoutTopology(
        buildTopoCluster(pods ?? [], nodes ?? [], infra ?? [], attestByUid, cvmPeerPods),
        spokes.length,
      ),
    [pods, nodes, infra, attestByUid, cvmPeerPods, spokes.length],
  );

  const loading = !tcLoaded || !podsLoaded || !nodesLoaded;

  const renderNode = (ln: LaidNode) => {
    const { node } = ln;
    const tee = teeShort(node.tee);
    const clickable = node.known && node.name !== '';
    const openNode = () => void navigate(`/k8s/cluster/nodes/${node.name}`);
    return (
      <g
        key={`node-${node.name || 'unscheduled'}`}
        className={clickable ? `${PREFIX}__topo-clickable` : undefined}
        onClick={clickable ? openNode : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (e.key === ' ') e.preventDefault();
                  openNode();
                }
              }
            : undefined
        }
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? t('Node {{name}}', { name: node.name }) : undefined}
      >
        <rect
          x={ln.x}
          y={ln.y}
          width={ln.w}
          height={ln.h}
          rx={8}
          className={`${PREFIX}__topo-node`}
        />
        {node.name ? (
          <>
            <circle
              cx={ln.x + 14}
              cy={ln.y + 16}
              r={4}
              className={node.ready ? dotClass('healthy') : dotClass('error')}
            />
            <text x={ln.x + 26} y={ln.y + 20} className={`${PREFIX}__topo-text`}>
              {truncate(node.name, 30)}
            </text>
            {tee && (
              <text
                x={ln.x + ln.w - 10}
                y={ln.y + 20}
                textAnchor="end"
                className={`${PREFIX}__topo-subtle`}
              >
                {tee}
              </text>
            )}
            <title>{`${node.name} — ${teeLong(node.tee)} — ${node.ready ? 'Ready' : 'Not ready'}`}</title>
          </>
        ) : (
          <text x={ln.x + 14} y={ln.y + 20} className={`${PREFIX}__topo-subtle`}>
            {t('Unscheduled — awaiting placement')}
          </text>
        )}
      </g>
    );
  };

  const renderWorkload = (lw: LaidWorkload) => {
    const { wl } = lw;
    // Does this workload actually attest to THIS Trustee? Decoded from its initdata.
    const elsewhere = wl.attest === 'remote' || wl.attest === 'none';
    const attestText =
      wl.attest === 'local'
        ? t('↳ attests here')
        : wl.attest === 'remote'
          ? `↗ ${truncate(wl.attestHost ?? t('remote Trustee'), 19)}`
          : wl.attest === 'none'
            ? t('no initdata')
            : t('↳ checking…');
    const attestCls =
      wl.attest === 'local'
        ? `${PREFIX}__topo-attest--local`
        : wl.attest === 'remote'
          ? `${PREFIX}__topo-attest--remote`
          : `${PREFIX}__topo-attest--none`;
    const attestTitle =
      wl.attest === 'local'
        ? t('attests to this Trustee')
        : wl.attest === 'remote'
          ? t('attests to a remote Trustee at {{host}}', { host: wl.attestHost ?? '?' })
          : wl.attest === 'none'
            ? t('no initdata — does not attest')
            : t('decoding initdata…');
    const openWorkload = () => void navigate(`/k8s/ns/${wl.namespace}/pods/${wl.name}`);
    return (
      <g
        key={wl.uid}
        className={`${PREFIX}__topo-clickable`}
        onClick={openWorkload}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (e.key === ' ') e.preventDefault();
            openWorkload();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={t('Workload {{namespace}}/{{name}}', {
          namespace: wl.namespace,
          name: wl.name,
        })}
      >
        <rect
          x={lw.x}
          y={lw.y}
          width={lw.w}
          height={lw.h}
          rx={6}
          className={`${PREFIX}__topo-wl`}
          strokeDasharray={elsewhere ? '4 3' : undefined}
        />
        <circle cx={lw.x + 14} cy={lw.y + 16} r={4} className={dotClass(wl.status)} />
        <text x={lw.x + 26} y={lw.y + 19} className={`${PREFIX}__topo-text`}>
          {truncate(wl.name, 17)}
        </text>
        {wl.gpu && (
          <text
            x={lw.x + lw.w - 8}
            y={lw.y + 19}
            textAnchor="end"
            className={`${PREFIX}__topo-subtle`}
          >
            {t('GPU')}
          </text>
        )}
        <text x={lw.x + 26} y={lw.y + 34} className={`${PREFIX}__topo-subtle`}>
          {truncate(wl.namespace, 20)}
        </text>
        <text x={lw.x + 26} y={lw.y + 50} className={attestCls}>
          {attestText}
        </text>
        <title>{`${wl.namespace}/${wl.name} · ${wl.runtime} · ${wl.status} · ${attestTitle}`}</title>
      </g>
    );
  };

  // One remote source row inside the spoke box: a confidential workload in another
  // cluster that reached this Trustee's KBS (grouped by source IP).
  const renderSpoke = (s: RemoteSpoke, i: number) => {
    const sp = layout.spoke;
    const rowTop = sp.y + sp.headerH + i * SPOKE_ROW_H;
    const status: WlStatus = s.attestOk ? 'healthy' : s.attestDenied ? 'error' : 'pending';
    const statusWord = s.attestOk ? t('attested') : s.attestDenied ? t('rejected') : t('attesting');
    const statusCls = s.attestOk
      ? `${PREFIX}__topo-attest--local`
      : s.attestDenied
        ? `${PREFIX}__topo-attest--none`
        : `${PREFIX}__topo-attest--remote`;
    const right = `${t('{{num}} secret(s) released', { num: s.released })}${
      s.lastSeen ? ` · ${relativeTime(s.lastSeen)}` : ''
    }`;
    const paths = s.resources.map((r) => r.path).join(' · ');
    return (
      <g key={s.clientIp}>
        <circle cx={sp.x + 16} cy={rowTop + 13} r={4} className={dotClass(status)} />
        <text x={sp.x + 30} y={rowTop + 17} className={`${PREFIX}__topo-mono`}>
          {s.clientIp}
        </text>
        <text x={sp.x + 172} y={rowTop + 17} className={statusCls}>
          {statusWord}
        </text>
        <text
          x={sp.x + sp.w - 14}
          y={rowTop + 17}
          textAnchor="end"
          className={`${PREFIX}__topo-subtle`}
        >
          {right}
        </text>
        {paths && (
          <text x={sp.x + 30} y={rowTop + 33} className={`${PREFIX}__topo-mono`}>
            {truncate(paths, 84)}
          </text>
        )}
        <title>{`${s.clientIp} — ${statusWord} · ${paths}`}</title>
      </g>
    );
  };

  const cluster = layout.cluster;

  return (
    <>
      <DocumentTitle>{t('Attestation topology')}</DocumentTitle>
      <ListPageHeader title={t('Attestation topology')} />
      <PageSection>
        {loading ? (
          <Bullseye>
            <Spinner aria-label={t('Loading')} />
          </Bullseye>
        ) : tcLoaded && trusteeConfigs.length === 0 ? (
          <EmptyTrustee />
        ) : (
          <>
            <Alert
              variant="info"
              isInline
              isExpandable
              title={t('How Trustee attests these workloads')}
              className={`${PREFIX}__mb`}
            >
              <Content component="p">
                {t(
                  'Trustee is the attestation hub. Its Key Broker Service (KBS) verifies a confidential workload’s hardware evidence at boot and only then releases secrets and keys to it. Each workload runs inside a node’s Trusted Execution Environment, in a cluster — shown here nested as workload → node → cluster.',
                )}
              </Content>
              <Content component="p">
                {t(
                  'One Trustee can attest workloads across many clusters (hub-and-spoke). This view shows the workloads running in the current cluster, and which Trustee each one actually attests to (read from its initdata): a solid box marked “↳ attests here” targets this Trustee; a dashed box marked “↗ …” attests to a remote Trustee and is NOT verified here; “no initdata” means it does not attest at all. Remote spoke clusters reach this Trustee over the network through its external Route (shown below) — the in-cluster Service DNS only works for co-located workloads. Because spokes connect through the Route, the KBS records the cluster router’s address as the source, so remote attestations are grouped by that source IP rather than per workload; the released resources show what each attested.',
                )}
              </Content>
            </Alert>

            <div className={`${PREFIX}__legend ${PREFIX}__mb`}>
              <LegendDot variant="healthy" label={t('Running')} />
              <LegendDot variant="pending" label={t('Pending')} />
              <LegendDot variant="error" label={t('Failed')} />
              <span className={`${PREFIX}__muted`}>
                {t('Select the Trustee hub, a node, or a workload to open it.')}
              </span>
              <Button
                variant="link"
                isInline
                icon={<SyncAltIcon />}
                onClick={refresh}
                isLoading={spokesLoading}
              >
                {t('Refresh remote attestations')}
              </Button>
              {fetchedAt && (
                <span className={`${PREFIX}__muted`}>
                  {t('updated {{time}}', { time: relativeTime(fetchedAt) })}
                </span>
              )}
            </div>

            <div className={`${PREFIX}__topo`}>
              <svg
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label={t('Attestation topology diagram')}
              >
                <defs>
                  <marker
                    id="trustee-topo-arrow"
                    markerWidth={9}
                    markerHeight={9}
                    refX={7}
                    refY={4.5}
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M0,0 L9,4.5 L0,9 z" className={`${PREFIX}__topo-arrowhead`} />
                  </marker>
                </defs>

                {/* attestation edges: solid = this cluster, dashed = remote spokes */}
                {layout.edges.map((e, i) => (
                  <path
                    key={`edge-${i}`}
                    d={`M ${e.x1} ${e.y1} C ${e.x1 + 40} ${e.y1}, ${e.x2 - 40} ${e.y2}, ${e.x2} ${e.y2}`}
                    className={`${PREFIX}__topo-edge${e.dashed ? ` ${PREFIX}__topo-edge--dashed` : ''}`}
                    markerEnd="url(#trustee-topo-arrow)"
                  />
                ))}
                <text
                  x={(layout.edges[0].x1 + layout.edges[0].x2) / 2}
                  y={(layout.edges[0].y1 + layout.edges[0].y2) / 2 - 6}
                  textAnchor="middle"
                  className={`${PREFIX}__topo-subtle`}
                >
                  {t('attests')}
                </text>

                {/* Trustee hub */}
                <g
                  className={`${PREFIX}__topo-clickable`}
                  onClick={() => void navigate('/trustee')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      if (e.key === ' ') e.preventDefault();
                      void navigate('/trustee');
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={t('Trustee attestation hub')}
                >
                  <rect
                    x={layout.hub.x}
                    y={layout.hub.y}
                    width={layout.hub.w}
                    height={layout.hub.h}
                    rx={10}
                    className={`${PREFIX}__topo-hub`}
                  />
                  <text
                    x={layout.hub.x + 16}
                    y={layout.hub.y + 30}
                    className={`${PREFIX}__topo-title`}
                  >
                    {t('Trustee')}
                  </text>
                  <text
                    x={layout.hub.x + 16}
                    y={layout.hub.y + 50}
                    className={`${PREFIX}__topo-subtle`}
                  >
                    {t('Attestation hub · KBS')}
                  </text>
                  <circle
                    cx={layout.hub.x + 20}
                    cy={layout.hub.y + 68}
                    r={5}
                    className={hubReady ? dotClass('healthy') : dotClass('pending')}
                  />
                  <text
                    x={layout.hub.x + 32}
                    y={layout.hub.y + 72}
                    className={`${PREFIX}__topo-text`}
                  >
                    {hubReady ? t('Ready') : t('Pending')}
                  </text>
                  <text
                    x={layout.hub.x + 16}
                    y={layout.hub.y + 94}
                    className={`${PREFIX}__topo-mono`}
                  >
                    {truncate(kbsEndpoint, 26)}
                  </text>
                  <title>{kbsEndpoint}</title>
                </g>

                {/* this cluster */}
                <rect
                  x={cluster.x}
                  y={cluster.y}
                  width={cluster.w}
                  height={cluster.h}
                  rx={12}
                  className={`${PREFIX}__topo-cluster`}
                />
                <text x={cluster.x + 14} y={cluster.y + 26} className={`${PREFIX}__topo-title`}>
                  {truncate(cluster.name, 40)}
                </text>
                <text x={cluster.x + 14} y={cluster.y + 42} className={`${PREFIX}__topo-subtle`}>
                  {t('{{num}} confidential workloads', { num: cluster.workloadCount })}
                  {` · ${t('{{num}} nodes', { num: cluster.nodes.length })}`}
                </text>
                <circle
                  cx={cluster.x + cluster.w - 54}
                  cy={cluster.y + 22}
                  r={4}
                  className={dotClass('healthy')}
                />
                <text
                  x={cluster.x + cluster.w - 46}
                  y={cluster.y + 26}
                  className={`${PREFIX}__topo-subtle`}
                >
                  {t('live')}
                </text>

                {cluster.empty && (
                  <text
                    x={cluster.x + cluster.w / 2}
                    y={cluster.y + cluster.headerH + 34}
                    textAnchor="middle"
                    className={`${PREFIX}__topo-subtle`}
                  >
                    {t('No confidential workloads found in this cluster yet.')}
                  </text>
                )}

                {cluster.nodes.map((ln) => (
                  <g key={`group-${ln.node.name || 'unscheduled'}`}>
                    {renderNode(ln)}
                    {ln.workloads.map(renderWorkload)}
                  </g>
                ))}

                {/* remote spoke clusters — confidential workloads in OTHER clusters
                    that attested to this Trustee, read live from the KBS log */}
                <rect
                  x={layout.spoke.x}
                  y={layout.spoke.y}
                  width={layout.spoke.w}
                  height={layout.spoke.h}
                  rx={12}
                  className={`${PREFIX}__topo-cluster--spoke`}
                />
                <text
                  x={layout.spoke.x + 14}
                  y={layout.spoke.y + 24}
                  className={`${PREFIX}__topo-title`}
                >
                  {t('Remote spoke clusters')}
                </text>
                <text
                  x={layout.spoke.x + 14}
                  y={layout.spoke.y + 44}
                  className={`${PREFIX}__topo-subtle`}
                >
                  {spokesError
                    ? t('Could not read the KBS log')
                    : spokes.length > 0
                      ? t('{{num}} remote source(s) attesting to this Trustee — from the KBS log', {
                          num: spokes.length,
                        })
                      : spokesLoading
                        ? t('Reading the KBS log…')
                        : remoteEndpoint
                          ? t('Confidential workloads in other clusters attest to this Trustee at:')
                          : t(
                              'To attest workloads in other clusters, expose kbs-service through a Route:',
                            )}
                </text>
                {spokes.length > 0 ? (
                  spokes.map(renderSpoke)
                ) : (
                  <text
                    x={layout.spoke.x + 14}
                    y={layout.spoke.y + 70}
                    className={`${PREFIX}__topo-mono`}
                  >
                    {spokesError
                      ? truncate(spokesError, 56)
                      : remoteEndpoint
                        ? truncate(remoteEndpoint, 56)
                        : t('no external Route configured yet')}
                    <title>
                      {remoteEndpoint || t('No Route targets kbs-service in this namespace')}
                    </title>
                  </text>
                )}
              </svg>
            </div>
          </>
        )}
      </PageSection>
    </>
  );
};

export default TrusteeTopology;
