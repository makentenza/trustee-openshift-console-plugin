import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

/** A v1 ConfigMap (we read/write .data — policies, reference values, KBS config). */
export type ConfigMapKind = K8sResourceCommon & {
  data?: Record<string, string>;
};

/** A v1 Secret (we read .type / key names, never values; write via stringData). */
export type SecretKind = K8sResourceCommon & {
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
};

export type ContainerStatusKind = {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: { exitCode?: number; reason?: string; finishedAt?: string };
  };
  image?: string;
};

/**
 * Minimal batch/v1 Job shape — the reference-value generator watches the veritas
 * Job and reports active / succeeded / failed.
 */
export type JobKind = K8sResourceCommon & {
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
};

/** Minimal apps/v1 Deployment shape — the Health tab reads replica counts. */
export type DeploymentKind = K8sResourceCommon & {
  spec?: {
    replicas?: number;
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
};

/** Minimal Pod shape we rely on (attestation verification reads runtimeClass + initdata). */
export type PodKind = K8sResourceCommon & {
  spec?: {
    runtimeClassName?: string;
    nodeName?: string;
    containers?: { name: string; image?: string }[];
  };
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: ContainerStatusKind[];
  };
};

/** TEE technology detected on a node from NFD labels. */
export type TeeType = 'tdx' | 'snp' | 'none';

/** A v1 Node — the topology view reads labels (TEE) and the Ready condition. */
export type NodeKind = K8sResourceCommon & {
  status?: {
    conditions?: { type: string; status: string }[];
  };
};

/**
 * config.openshift.io/v1 Infrastructure (cluster-scoped singleton "cluster") — gives
 * the topology view this cluster's identity and platform.
 */
export type InfrastructureKind = K8sResourceCommon & {
  status?: {
    infrastructureName?: string;
    platform?: string;
    controlPlaneTopology?: string;
  };
};

/** A v1 Namespace — we only check existence by name. */
export type NamespaceKind = K8sResourceCommon;

/** A route.openshift.io/v1 Route — we read the host + which Service it targets. */
export type RouteKind = K8sResourceCommon & {
  spec?: {
    host?: string;
    to?: { name?: string };
    tls?: { termination?: string };
  };
  status?: { ingress?: { host?: string }[] };
};

/** A v1 Event — the attestation probe scans reason/message for failure signatures. */
export type EventKind = K8sResourceCommon & {
  reason?: string;
  message?: string;
  type?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { uid?: string; name?: string; namespace?: string; kind?: string };
};

/**
 * confidentialcontainers.org/v1alpha1 TrusteeConfig — the high-level, user-facing
 * attestation CR. The operator generates the KBS, KbsConfig, policies, reference
 * values, and secrets from it.
 */
export type TrusteeConfigKind = K8sResourceCommon & {
  spec?: {
    profileType?: 'Permissive' | 'Restricted';
    kbsServiceType?: string;
    httpsSpec?: { tlsSecretName?: string };
    attestationTokenVerificationSpec?: { tlsSecretName?: string };
  };
  status?: {
    isReady?: boolean;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
};

/**
 * confidentialcontainers.org/v1alpha1 KbsConfig — the lower-level CR the operator
 * generates from a TrusteeConfig. Edited directly only for advanced use.
 */
export type KbsConfigKind = K8sResourceCommon & {
  spec?: {
    kbsServiceType?: string;
    kbsSecretResources?: string[];
    kbsDeploymentSpec?: {
      replicas?: number;
    };
    /** Local certificate cache settings (advanced); shape is opaque here. */
    kbsLocalCertCacheSpec?: Record<string, unknown>;
  };
  status?: {
    isReady?: boolean;
  };
};
