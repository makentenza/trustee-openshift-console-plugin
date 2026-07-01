// ---------------------------------------------------------------------------
// Topology model + layout for the Trustee attestation view.
//
// Trustee is the hub: one KBS deployment brokers secrets to confidential
// workloads after verifying their attestation evidence. A workload runs in a
// node, in a cluster — so we render that nesting (workload ∈ node ∈ cluster)
// with the Trustee hub attesting the cluster(s).
//
// The console can only watch the cluster it runs in, so the live data is this
// cluster's confidential pods. The hub-and-spoke nature (one Trustee, many
// clusters) is shown by the dashed "spoke clusters" container — remote spokes
// attest over the network to the same KBS endpoint; we do not fabricate them.
// ---------------------------------------------------------------------------
import { CC_INIT_DATA_ANNOTATION, SNP_NODE_LABEL, TDX_NODE_LABEL } from '../k8s/resources';
import type { InfrastructureKind, NodeKind, PodKind, TeeType } from '../k8s/types';

export type WlStatus = 'healthy' | 'pending' | 'error';

/**
 * Which Trustee a workload actually attests to, read from its initdata KBS URL:
 * - 'local'  — this in-cluster Trustee (kbs-service)
 * - 'remote' — a different Trustee (external route / hub) — NOT attested here
 * - 'none'   — no initdata, so it does not attest at all
 * - 'unknown'— has initdata but the URL hasn't been decoded yet
 */
export type AttestKind = 'local' | 'remote' | 'none' | 'unknown';
export interface AttestInfo {
  target: 'local' | 'remote';
  host: string;
}

export interface TopoWorkload {
  uid: string;
  name: string;
  namespace: string;
  nodeName: string; // '' when the pod is not yet scheduled to a node
  runtime: string;
  gpu: boolean;
  status: WlStatus;
  attest: AttestKind;
  attestHost?: string; // the KBS host this workload attests to (when remote)
}

export interface TopoNode {
  name: string; // '' for the synthetic "unscheduled" bucket
  tee: TeeType;
  ready: boolean;
  known: boolean; // matched a real Node object
  workloads: TopoWorkload[];
}

export interface TopoCluster {
  name: string;
  nodes: TopoNode[];
  workloadCount: number;
}

// ---- classification helpers ----

/**
 * A confidential-containers pod runs on the kata-cc family (bare-metal on-node TEE), or —
 * only when peer pods on this cluster are Confidential VMs — kata-remote (cloud peer pods,
 * Azure SEV-SNP / TDX). Pass `cvmPeerPods` from {@link cvmPeerPodsEnabled} so cloud
 * workloads appear in the attestation views while plain non-CVM peer pods stay excluded.
 */
export const isConfidentialRuntimeName = (name?: string, cvmPeerPods = false): boolean =>
  !!name && (name.startsWith('kata-cc') || (cvmPeerPods && name === 'kata-remote'));

/** A kata-remote (peer-pod) runtime — its TEE is a cloud Confidential VM, not a cluster node. */
export const isPeerPodRuntime = (name?: string): boolean => name === 'kata-remote';

/**
 * Peer pods on this cluster run as Confidential VMs when peer-pods-cm has a CLOUD_PROVIDER
 * and CVMs are not disabled (DISABLECVM !== 'true'). Only then may kata-remote workloads
 * appear in the confidential attestation views.
 */
export const cvmPeerPodsEnabled = (peerPodsCmData?: Record<string, string>): boolean =>
  Boolean(peerPodsCmData?.CLOUD_PROVIDER) && peerPodsCmData?.DISABLECVM !== 'true';

export const teeTypeForNode = (node?: NodeKind): TeeType => {
  const labels = node?.metadata?.labels ?? {};
  if (labels[TDX_NODE_LABEL] === 'true') return 'tdx';
  if (labels[SNP_NODE_LABEL] === 'true') return 'snp';
  return 'none';
};

/**
 * Best-effort cluster TEE platform from node NFD labels — used to pre-select the
 * reference-value generator's platform instead of forcing a manual TDX/SNP pick
 * (a wrong choice makes evidence never match, with no error). Returns the first
 * TEE found scanning nodes; `null` when no node carries a TEE label.
 */
export const detectClusterTee = (nodes: NodeKind[]): 'tdx' | 'snp' | null => {
  for (const node of nodes) {
    const tee = teeTypeForNode(node);
    if (tee !== 'none') return tee;
  }
  return null;
};

export const teeShort = (tee: TeeType): string =>
  tee === 'tdx' ? 'TDX' : tee === 'snp' ? 'SEV-SNP' : '';

export const teeLong = (tee: TeeType): string =>
  tee === 'tdx' ? 'Intel TDX' : tee === 'snp' ? 'AMD SEV-SNP' : 'No TEE node label';

const nodeReady = (node?: NodeKind): boolean =>
  (node?.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

export const podStatusCategory = (pod: PodKind): WlStatus => {
  const phase = pod.status?.phase;
  const waitingBad = (pod.status?.containerStatuses ?? []).some(
    (c) =>
      c.state?.waiting &&
      /CrashLoopBackOff|RunContainerError|CreateContainerError|ImagePullBackOff|ErrImagePull/i.test(
        c.state.waiting.reason ?? '',
      ),
  );
  if (waitingBad) return 'error';
  if (phase === 'Running' || phase === 'Succeeded') return 'healthy';
  if (phase === 'Failed' || phase === 'Unknown') return 'error';
  return 'pending';
};

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

// ---- attestation target (decode the pod's initdata) ----

/**
 * Decode the KBS URL out of a pod's `cc_init_data` annotation (gzip+base64 of an
 * initdata.toml) in the browser. Returns null if absent/undecodable.
 */
export const decodeInitdataKbsUrl = async (annotation: string): Promise<string | null> => {
  try {
    const bin = atob(annotation.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const toml = await new Response(stream).text();
    const m = toml.match(/url\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
};

/** Is this KBS URL the in-cluster Trustee (kbs-service) or a remote one? */
export const classifyKbsUrl = (kbsUrl: string, localServiceName: string): AttestInfo => {
  let host = kbsUrl;
  try {
    host = new URL(kbsUrl).host;
  } catch {
    /* keep the raw string */
  }
  const local = host.startsWith(`${localServiceName}.`) || host.startsWith(`${localServiceName}:`);
  return { target: local ? 'local' : 'remote', host };
};

// ---- model ----

/** Build the live (this-cluster) topology model from confidential pods + nodes. */
export const buildTopoCluster = (
  pods: PodKind[],
  nodes: NodeKind[],
  infra: InfrastructureKind[],
  attestByUid: Map<string, AttestInfo> = new Map(),
  cvmPeerPods = false,
): TopoCluster => {
  const clusterName =
    infra.find((i) => i.metadata?.name === 'cluster')?.status?.infrastructureName ?? 'This cluster';

  const nodeByName = new Map<string, NodeKind>();
  nodes.forEach((n) => {
    const nm = n.metadata?.name;
    if (nm) nodeByName.set(nm, n);
  });

  const confidential = pods.filter((p) =>
    isConfidentialRuntimeName(p.spec?.runtimeClassName, cvmPeerPods),
  );

  const byNode = new Map<string, TopoWorkload[]>();
  confidential.forEach((p) => {
    const nodeName = p.spec?.nodeName ?? '';
    const runtime = p.spec?.runtimeClassName ?? '';
    const uid = p.metadata?.uid ?? `${p.metadata?.namespace ?? ''}/${p.metadata?.name ?? ''}`;
    const hasInitData = !!p.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION];
    const decoded = attestByUid.get(uid);
    const attest: AttestKind = !hasInitData ? 'none' : decoded ? decoded.target : 'unknown';
    const wl: TopoWorkload = {
      uid,
      name: p.metadata?.name ?? '',
      namespace: p.metadata?.namespace ?? '',
      nodeName,
      runtime,
      gpu: runtime.includes('gpu'),
      status: podStatusCategory(p),
      attest,
      attestHost: decoded?.host,
    };
    const arr = byNode.get(nodeName) ?? [];
    arr.push(wl);
    byNode.set(nodeName, arr);
  });

  const topoNodes: TopoNode[] = [...byNode.entries()]
    .map(([name, workloads]) => {
      const obj = name ? nodeByName.get(name) : undefined;
      return {
        name,
        tee: teeTypeForNode(obj),
        ready: name ? nodeReady(obj) : false,
        known: !!obj,
        workloads: [...workloads].sort((a, b) =>
          `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
        ),
      };
    })
    // real nodes alphabetically; the unscheduled ('') bucket sinks to the bottom
    .sort((a, b) => {
      if (a.name === '') return 1;
      if (b.name === '') return -1;
      return a.name.localeCompare(b.name);
    });

  return { name: clusterName, nodes: topoNodes, workloadCount: confidential.length };
};

// ---- layout (pure geometry; pixel coordinates for the SVG) ----

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LaidWorkload extends Rect {
  wl: TopoWorkload;
}
export interface LaidNode extends Rect {
  node: TopoNode;
  headerH: number;
  workloads: LaidWorkload[];
}
export interface LaidCluster extends Rect {
  name: string;
  headerH: number;
  nodes: LaidNode[];
  workloadCount: number;
  empty: boolean;
}
export interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
}
export interface Layout {
  width: number;
  height: number;
  hub: Rect;
  cluster: LaidCluster;
  spoke: Rect & { headerH: number };
  edges: Edge[];
}

const GEO = {
  pad: 16,
  hubW: 208,
  hubH: 112,
  arrowGap: 80,
  clusterW: 600,
  clusterPad: 14,
  clusterHeaderH: 46,
  nodeGap: 12,
  nodePad: 12,
  nodeHeaderH: 32,
  wlW: 174,
  wlH: 60,
  wlGap: 10,
  emptyH: 48,
  clusterGap: 22,
  spokeH: 96,
};

/** Height of one remote-spoke row in the enlarged spoke box (two text lines). */
export const SPOKE_ROW_H = 42;
/** Header height of the spoke box (title + sub-line) when it lists remote sources. */
const SPOKE_HEADER_H = 56;

export const layoutTopology = (cluster: TopoCluster, spokeRows = 0): Layout => {
  const g = GEO;
  const clusterX = g.pad + g.hubW + g.arrowGap;
  const innerW = g.clusterW - 2 * g.clusterPad; // node-box width
  const nodeInnerW = innerW - 2 * g.nodePad;
  const cols = Math.max(1, Math.floor((nodeInnerW + g.wlGap) / (g.wlW + g.wlGap)));

  const nodeX = clusterX + g.clusterPad;
  const wlX0 = nodeX + g.nodePad;
  let cursorY = g.pad + g.clusterHeaderH + g.clusterPad; // first node top

  const laidNodes: LaidNode[] = cluster.nodes.map((node) => {
    const rows = Math.max(1, Math.ceil(node.workloads.length / cols));
    const contentH = rows * g.wlH + (rows - 1) * g.wlGap;
    const nodeH = g.nodeHeaderH + contentH + g.nodePad;
    const nodeTop = cursorY;
    const wlY0 = nodeTop + g.nodeHeaderH;
    const workloads: LaidWorkload[] = node.workloads.map((wl, i) => ({
      wl,
      x: wlX0 + (i % cols) * (g.wlW + g.wlGap),
      y: wlY0 + Math.floor(i / cols) * (g.wlH + g.wlGap),
      w: g.wlW,
      h: g.wlH,
    }));
    cursorY = nodeTop + nodeH + g.nodeGap;
    return { node, x: nodeX, y: nodeTop, w: innerW, h: nodeH, headerH: g.nodeHeaderH, workloads };
  });

  const empty = cluster.nodes.length === 0;
  const contentBottom = empty
    ? g.pad + g.clusterHeaderH + g.clusterPad + g.emptyH
    : cursorY - g.nodeGap; // bottom of the last node
  const clusterH = contentBottom - g.pad + g.clusterPad;

  const laidCluster: LaidCluster = {
    name: cluster.name,
    x: clusterX,
    y: g.pad,
    w: g.clusterW,
    h: clusterH,
    headerH: g.clusterHeaderH,
    nodes: laidNodes,
    workloadCount: cluster.workloadCount,
    empty,
  };

  const spokeY = g.pad + clusterH + g.clusterGap;
  // The spoke box grows to list the remote sources that actually attested (read
  // from the KBS log); empty, it falls back to the fixed guidance height.
  const spokeH = spokeRows > 0 ? SPOKE_HEADER_H + spokeRows * SPOKE_ROW_H + g.clusterPad : g.spokeH;
  const spoke = { x: clusterX, y: spokeY, w: g.clusterW, h: spokeH, headerH: SPOKE_HEADER_H };

  const hub: Rect = { x: g.pad, y: g.pad + clusterH / 2 - g.hubH / 2, w: g.hubW, h: g.hubH };

  const hubRightX = hub.x + hub.w;
  const hubMidY = hub.y + hub.h / 2;
  const edges: Edge[] = [
    { x1: hubRightX, y1: hubMidY, x2: clusterX, y2: g.pad + clusterH / 2, dashed: false },
    { x1: hubRightX, y1: hubMidY, x2: clusterX, y2: spokeY + spokeH / 2, dashed: true },
  ];

  return {
    width: clusterX + g.clusterW + g.pad,
    height: spokeY + spokeH + g.pad,
    hub,
    cluster: laidCluster,
    spoke,
    edges,
  };
};
