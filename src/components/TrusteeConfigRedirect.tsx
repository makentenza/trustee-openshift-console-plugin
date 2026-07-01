import type { FC } from 'react';
import { Navigate } from 'react-router-dom-v5-compat';
import { Bullseye, Spinner } from '@patternfly/react-core';
import { useTrusteeConfigs } from '../k8s/hooks';
import { TRUSTEE_NAMESPACE, TrusteeConfigModelRef } from '../k8s/resources';

/**
 * The TrusteeConfig is a singleton — the operator reconciles one per cluster — so a
 * resource LIST reads as if several are expected (#23). This nav target instead sends the
 * admin straight to the one TrusteeConfig's detail (its configuration tabs), or to the
 * setup page when none exists yet. If, unexpectedly, more than one exists, fall back to the
 * standard list so none is hidden.
 */
const TrusteeConfigRedirect: FC = () => {
  const [tcs, loaded] = useTrusteeConfigs();
  if (!loaded) {
    return (
      <Bullseye>
        <Spinner />
      </Bullseye>
    );
  }
  if (tcs.length > 1) {
    return <Navigate to={`/k8s/all-namespaces/${TrusteeConfigModelRef}`} replace />;
  }
  const tc = tcs[0];
  if (!tc?.metadata?.name) {
    return <Navigate to="/trustee/setup" replace />;
  }
  const ns = tc.metadata.namespace ?? TRUSTEE_NAMESPACE;
  return <Navigate to={`/k8s/ns/${ns}/${TrusteeConfigModelRef}/${tc.metadata.name}`} replace />;
};

export default TrusteeConfigRedirect;
