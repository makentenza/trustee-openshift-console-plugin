// ---------------------------------------------------------------------------
// Attestation status + probe for confidential workloads.
//
// The console can't run the in-guest attestation handshake itself, but it can
// observe everything around it: whether the pod carries initdata, whether it
// landed on a TEE node, whether the Trustee KBS is up, whether any reference
// values are registered, the pod's runtime state, and its recent events. We
// combine those into a verdict and concrete remediation, and still offer the
// definitive in-guest CDH check as a copyable command.
// ---------------------------------------------------------------------------
import {
  CC_INIT_DATA_ANNOTATION,
  CDH_RESOURCE_PROBE_PORT,
  COCO_CREATE_WORKLOAD_ROUTE,
  COCO_TEE_NODES_ROUTE,
} from '../k8s/resources';
import type { EventKind, NodeKind, PodKind, TeeType } from '../k8s/types';
import { isConfidentialRuntimeName, isPeerPodRuntime, teeLong, teeTypeForNode } from './topology';

export type Verdict = 'healthy' | 'failing' | 'no-attestation' | 'pending' | 'unknown';

export interface AttestWorkload {
  uid: string;
  name: string;
  namespace: string;
  nodeName: string;
  runtime: string;
  gpu: boolean;
  hasInitData: boolean;
  phase: string;
  ready: boolean;
  containerIssue?: string;
  tee: TeeType;
  onTeeNode: boolean;
  nodeKnown: boolean;
  /** kata-remote peer pod — its TEE is a cloud Confidential VM, not a cluster node. */
  peerPod: boolean;
}

export interface AttestContext {
  kbsReady: boolean;
  referenceValuesPresent: boolean;
}

export type CheckState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface Remediation {
  text: string;
  href?: string;
  /** When true, the UI renders the in-guest CDH probe command instead of a link. */
  cdhCommand?: boolean;
  /**
   * When true, `href` points into the separate confidential-containers (CoCo)
   * plugin (`/confidential-containers/*`). The UI must render it as plain text
   * (not a link) on a Trustee-only "hub" cluster where CoCo is not installed,
   * otherwise the link 404s. See utils/crossPlugin.ts.
   */
  crossPlugin?: boolean;
}

const allReady = (pod: PodKind): boolean => {
  const cs = pod.status?.containerStatuses ?? [];
  return cs.length > 0 && cs.every((c) => c.ready);
};

const BAD_WAITING_RE =
  /CrashLoopBackOff|RunContainerError|CreateContainerError|CreateContainerConfigError|ImagePullBackOff|ErrImagePull/i;

const containerIssue = (pod: PodKind): string | undefined => {
  for (const c of pod.status?.containerStatuses ?? []) {
    const r = c.state?.waiting?.reason;
    if (r && BAD_WAITING_RE.test(r)) return r;
  }
  return undefined;
};

/**
 * Confidential pods, normalized for the attestation view: the kata-cc family (bare-metal
 * on-node TEE) plus, when `cvmPeerPods`, kata-remote (cloud Confidential-VM peer pods).
 */
export const buildAttestWorkloads = (
  pods: PodKind[],
  nodes: NodeKind[],
  cvmPeerPods = false,
): AttestWorkload[] => {
  const nodeByName = new Map<string, NodeKind>();
  nodes.forEach((n) => {
    const nm = n.metadata?.name;
    if (nm) nodeByName.set(nm, n);
  });
  return pods
    .filter((p) => isConfidentialRuntimeName(p.spec?.runtimeClassName, cvmPeerPods))
    .map((p) => {
      const nodeName = p.spec?.nodeName ?? '';
      const nodeObj = nodeName ? nodeByName.get(nodeName) : undefined;
      const tee = teeTypeForNode(nodeObj);
      const runtime = p.spec?.runtimeClassName ?? '';
      const peerPod = isPeerPodRuntime(runtime);
      return {
        uid: p.metadata?.uid ?? `${p.metadata?.namespace ?? ''}/${p.metadata?.name ?? ''}`,
        name: p.metadata?.name ?? '',
        namespace: p.metadata?.namespace ?? '',
        nodeName,
        runtime,
        gpu: runtime.includes('gpu'),
        hasInitData: Boolean(p.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION]),
        phase: p.status?.phase ?? 'Unknown',
        ready: allReady(p),
        containerIssue: containerIssue(p),
        tee,
        // A peer pod's TEE is the cloud CVM, not the worker node, so node TEE labels
        // don't apply — treat it as satisfying the "runs in a TEE" check.
        onTeeNode: peerPod || tee !== 'none',
        nodeKnown: Boolean(nodeObj),
        peerPod,
      };
    })
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
};

/** Verdict from observable signals, before the event probe runs. */
export const baselineVerdict = (w: AttestWorkload, ctx: AttestContext): Verdict => {
  if (!w.hasInitData) return 'no-attestation';
  if (w.nodeName && !w.onTeeNode) return 'failing';
  if (!ctx.kbsReady) return 'failing';
  if (w.containerIssue) return 'failing';
  if (w.phase === 'Running' && w.ready) return 'healthy';
  if (w.phase === 'Failed') return 'failing';
  if (w.phase === 'Pending' || !w.nodeName) return 'pending';
  return 'unknown';
};

export const verdictLabel = (v: Verdict): string =>
  ({
    healthy: 'Healthy',
    failing: 'Failing',
    'no-attestation': 'Not attesting',
    pending: 'Pending',
    unknown: 'Unknown',
  })[v];

export const verdictColor = (v: Verdict): 'green' | 'red' | 'orange' | 'blue' | 'grey' =>
  ({
    healthy: 'green',
    failing: 'red',
    'no-attestation': 'orange',
    pending: 'blue',
    unknown: 'grey',
  })[v] as 'green' | 'red' | 'orange' | 'blue' | 'grey';

export const buildChecks = (w: AttestWorkload, ctx: AttestContext): Check[] => [
  {
    id: 'initdata',
    label: 'Initdata',
    state: w.hasInitData ? 'ok' : 'fail',
    detail: w.hasInitData
      ? 'cc_init_data annotation present'
      : 'No cc_init_data annotation — the guest boots without attesting to Trustee',
  },
  {
    id: 'tee',
    label: w.peerPod ? 'TEE' : 'TEE node',
    state: w.peerPod ? 'ok' : !w.nodeName ? 'unknown' : w.onTeeNode ? 'ok' : 'fail',
    detail: w.peerPod
      ? 'Cloud Confidential VM (peer pod) — the TEE is the cloud VM, not a cluster node'
      : !w.nodeName
        ? 'Not scheduled to a node yet'
        : w.onTeeNode
          ? `${w.nodeName} · ${teeLong(w.tee)}`
          : `${w.nodeName} has no TEE (TDX/SEV-SNP) node label`,
  },
  {
    id: 'kbs',
    label: 'Trustee KBS',
    state: ctx.kbsReady ? 'ok' : 'fail',
    detail: ctx.kbsReady ? 'Reachable and ready' : 'KBS is not ready — no workload can attest',
  },
  {
    id: 'refvals',
    label: 'Reference values',
    state: ctx.referenceValuesPresent ? 'ok' : 'warn',
    detail: ctx.referenceValuesPresent
      ? 'Registered in Trustee'
      : 'None registered — attestation is rejected until you add them',
  },
  {
    id: 'pod',
    label: 'Pod',
    state: w.phase === 'Running' && w.ready ? 'ok' : w.containerIssue ? 'fail' : 'warn',
    detail:
      w.containerIssue ?? `${w.phase}${w.phase === 'Running' && !w.ready ? ' · not ready' : ''}`,
  },
];

// Events that point at an attestation/confidential-runtime problem.
const ATTEST_EVENT_RE =
  /attest|\bkbs\b|reference value|confidential|\bcdh\b|sealed|\btee\b|tdx|sev|snp|sandbox|get_resource|secret|policy/i;
const BAD_REASON_RE = /Failed|BackOff|Error|Unhealthy|Evicted/i;

export interface ProbeEvent {
  reason: string;
  message: string;
  type: string;
  count: number;
  attestationRelated: boolean;
}

export const scanEvents = (events: EventKind[]): ProbeEvent[] =>
  events
    .map((e) => ({
      reason: e.reason ?? '',
      message: e.message ?? '',
      type: e.type ?? '',
      count: e.count ?? 1,
      attestationRelated: ATTEST_EVENT_RE.test(`${e.reason ?? ''} ${e.message ?? ''}`),
    }))
    .filter((e) => e.type === 'Warning' || e.attestationRelated)
    .slice(0, 12);

/** A blocking event is a Warning whose reason or message points at attestation/runtime failure. */
export const hasBlockingEvent = (events: ProbeEvent[]): boolean =>
  events.some(
    (e) => e.type === 'Warning' && (BAD_REASON_RE.test(e.reason) || e.attestationRelated),
  );

export const cdhProbeCommand = (ns: string, name: string): string =>
  `oc exec -it ${name} -n ${ns} -- curl http://127.0.0.1:${CDH_RESOURCE_PROBE_PORT}/cdh/resource/default/attestation-status/status`;

/** Concrete next actions, ordered by what's most likely blocking attestation. */
export const remediation = (
  w: AttestWorkload,
  ctx: AttestContext,
  blockingEvent: boolean,
  links?: { referenceValues?: string; health?: string },
): Remediation[] => {
  const r: Remediation[] = [];
  if (!w.hasInitData) {
    r.push({
      // Author initdata on this Trustee (the Initdata tab), then create the
      // workload with it in the CoCo plugin. The old link to
      // /confidential-containers/initdata 404'd — CoCo registers no such route;
      // its create-workload form is where initdata is pasted.
      text: 'This pod has no initdata, so it never contacts Trustee. Author initdata (Initdata tab), then rebuild the workload with it and redeploy.',
      href: COCO_CREATE_WORKLOAD_ROUTE,
      crossPlugin: true,
    });
  }
  if (w.nodeName && !w.onTeeNode) {
    r.push({
      text: 'The pod is on a node without a hardware TEE. Schedule it on an Intel TDX or AMD SEV-SNP node.',
      href: COCO_TEE_NODES_ROUTE,
      crossPlugin: true,
    });
  }
  if (!ctx.kbsReady) {
    r.push({
      text: 'Trustee KBS is not ready. No workload can attest until it is — check Trustee health.',
      href: links?.health ?? '/trustee',
    });
  }
  if (!ctx.referenceValuesPresent) {
    r.push({
      text: 'Trustee has no reference values. Register this workload’s PCR8 (from the initdata builder) under Reference values.',
      href: links?.referenceValues ?? '/trustee',
    });
  }
  if (w.hasInitData && w.onTeeNode && ctx.kbsReady && (blockingEvent || w.phase !== 'Running')) {
    r.push({
      text: 'Evidence may not match Trustee’s reference values or policy. Re-register the PCR8 for this exact initdata and review the attestation policy.',
      href: links?.referenceValues ?? '/trustee',
    });
  }
  r.push({
    text: 'Run the definitive in-guest check from a terminal (a success response confirms Trustee released the secret):',
    cdhCommand: true,
  });
  return r;
};
