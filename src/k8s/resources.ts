import type { K8sGroupVersionKind, K8sModel } from '@openshift-console/dynamic-plugin-sdk';

// ---------------------------------------------------------------------------
// Trustee / attestation. TrusteeConfig is the productized high-level CR; the
// operator generates a KbsConfig plus ConfigMaps/Secrets/Service/route from it.
//
// Group/version match the Red Hat build of Trustee CRDs as installed on-cluster:
//   trusteeconfigs.confidentialcontainers.org  (v1alpha1)
//   kbsconfigs.confidentialcontainers.org      (v1alpha1)
// NOTE: earlier drafts used group `trustee.confidentialcontainers.org` / `v1`,
// which matched no CRD — so the model flag never fired and the nav 404'd.
// ---------------------------------------------------------------------------
export const TRUSTEE_GROUP = 'confidentialcontainers.org';
export const TRUSTEE_VERSION = 'v1alpha1';

export const TrusteeConfigGVK: K8sGroupVersionKind = {
  group: TRUSTEE_GROUP,
  version: TRUSTEE_VERSION,
  kind: 'TrusteeConfig',
};

export const KbsConfigGVK: K8sGroupVersionKind = {
  group: TRUSTEE_GROUP,
  version: TRUSTEE_VERSION,
  kind: 'KbsConfig',
};

export const TrusteeConfigModel: K8sModel = {
  apiGroup: TRUSTEE_GROUP,
  apiVersion: TRUSTEE_VERSION,
  kind: 'TrusteeConfig',
  plural: 'trusteeconfigs',
  namespaced: true,
  abbr: 'TC',
  label: 'TrusteeConfig',
  labelPlural: 'TrusteeConfigs',
  crd: true,
};

export const KbsConfigModel: K8sModel = {
  apiGroup: TRUSTEE_GROUP,
  apiVersion: TRUSTEE_VERSION,
  kind: 'KbsConfig',
  plural: 'kbsconfigs',
  namespaced: true,
  abbr: 'KBS',
  label: 'KbsConfig',
  labelPlural: 'KbsConfigs',
  crd: true,
};

// ---- Core ----
export const PodGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Pod' };
export const ConfigMapGVK: K8sGroupVersionKind = { version: 'v1', kind: 'ConfigMap' };
export const SecretGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Secret' };
export const ServiceAccountGVK: K8sGroupVersionKind = { version: 'v1', kind: 'ServiceAccount' };
export const DeploymentGVK: K8sGroupVersionKind = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
};
export const JobGVK: K8sGroupVersionKind = { group: 'batch', version: 'v1', kind: 'Job' };

// config.openshift.io/v1 ClusterVersion — read status.desired.version to default
// the OCP version veritas pulls release extensions for.
export const ClusterVersionGVK: K8sGroupVersionKind = {
  group: 'config.openshift.io',
  version: 'v1',
  kind: 'ClusterVersion',
};

/** v1 Node — the topology view reads TEE labels + Ready to place confidential workloads. */
export const NodeGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Node' };

/** config.openshift.io/v1 Infrastructure (singleton "cluster") — read status.infrastructureName. */
export const InfrastructureGVK: K8sGroupVersionKind = {
  group: 'config.openshift.io',
  version: 'v1',
  kind: 'Infrastructure',
};

export const ConfigMapModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  plural: 'configmaps',
  namespaced: true,
  abbr: 'CM',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
};

export const SecretModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Secret',
  plural: 'secrets',
  namespaced: true,
  abbr: 'S',
  label: 'Secret',
  labelPlural: 'Secrets',
};

export const DeploymentModel: K8sModel = {
  apiGroup: 'apps',
  apiVersion: 'v1',
  kind: 'Deployment',
  plural: 'deployments',
  namespaced: true,
  abbr: 'D',
  label: 'Deployment',
  labelPlural: 'Deployments',
};

// ---- Reference-value generation (veritas in-cluster Job + its RBAC) ----
export const JobModel: K8sModel = {
  apiGroup: 'batch',
  apiVersion: 'v1',
  kind: 'Job',
  plural: 'jobs',
  namespaced: true,
  abbr: 'JOB',
  label: 'Job',
  labelPlural: 'Jobs',
};

export const ServiceAccountModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ServiceAccount',
  plural: 'serviceaccounts',
  namespaced: true,
  abbr: 'SA',
  label: 'ServiceAccount',
  labelPlural: 'ServiceAccounts',
};

export const RoleModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'Role',
  plural: 'roles',
  namespaced: true,
  abbr: 'R',
  label: 'Role',
  labelPlural: 'Roles',
};

export const RoleBindingModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'RoleBinding',
  plural: 'rolebindings',
  namespaced: true,
  abbr: 'RB',
  label: 'RoleBinding',
  labelPlural: 'RoleBindings',
};

/**
 * coco-tools image that ships the `veritas` reference-value generator (plus oc,
 * python3, bash, curl). Public — needs no pull secret to pull the image itself.
 */
export const COCO_TOOLS_IMAGE = 'quay.io/openshift_sandboxed_containers/coco-tools:1.12';

/**
 * Cluster pull secret. veritas needs it to pull the OCP release extensions image
 * (quay.io/openshift-release-dev) when computing measurements.
 */
export const CLUSTER_PULL_SECRET = { name: 'pull-secret', namespace: 'openshift-config' };

// ---- Well-known names / locations ----
/** Default namespace for the Red Hat build of Trustee operator. */
export const TRUSTEE_NAMESPACE = 'trustee-operator-system';
/** Label the Trustee operator puts on the KBS workload pods. */
export const KBS_POD_SELECTOR = 'app=kbs';
/** `metadata.labels.app` value KBS pods carry (the client-side filter key). */
export const KBS_POD_LABEL_KEY = 'app';
export const KBS_POD_LABEL_VALUE = 'kbs';
/** Deployment the operator creates for the KBS workload. */
export const TRUSTEE_KBS_DEPLOYMENT = 'trustee-deployment';
/** Deployment for the Trustee operator's controller-manager. */
export const TRUSTEE_OPERATOR_DEPLOYMENT = 'trustee-operator-controller-manager';
/**
 * Pod annotation carrying the gzip+base64 initdata for a confidential pod.
 * Authored on the workload (CoCo) side; the attestation-verify view reads it.
 */
export const CC_INIT_DATA_ANNOTATION = 'io.katacontainers.config.hypervisor.cc_init_data';

/** NFD labels that mark a node's hardware TEE capability (topology view). */
export const TDX_NODE_LABEL = 'intel.feature.node.kubernetes.io/tdx';
export const SNP_NODE_LABEL = 'amd.feature.node.kubernetes.io/snp';
/** The in-cluster Service the Trustee operator creates for the KBS workload. */
export const KBS_SERVICE_NAME = 'kbs-service';
export const KBS_SERVICE_PORT = 8080;

// `kind~group~version` reference string for tab/action/flag extensions.
export const TrusteeConfigModelRef = `${TRUSTEE_GROUP}~${TRUSTEE_VERSION}~TrusteeConfig`;
