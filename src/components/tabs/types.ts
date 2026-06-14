import type { TrusteeConfigKind } from '../../k8s/types';

// Components registered via `console.tab/horizontalNav` receive the details-page
// resource as `obj`.
export interface TrusteeTabProps {
  obj?: TrusteeConfigKind;
}
