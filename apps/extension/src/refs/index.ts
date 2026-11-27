// src/refs/index.ts —— TS ref 生命周期公共入口（签名纯函数 + 每 tab 注册表）。
export {
  assessObservationFreshness,
  assessRefMatch,
  generationOf,
  isFullRefKey,
  makeFenceKey,
  makeRefKey,
  makeStabilitySignature,
  nonEmpty,
  positiveInteger,
  refKeyId,
  sameRef,
  sameStabilitySignature,
  signatureHash,
  staleObservationCode,
  staleRefCode,
  STALE_REF_MESSAGES,
} from './signature.ts';
export type {
  ObservationFreshness,
  ObservationStamp,
  RefAssessment,
  RefExpectation,
  RefKey,
  RefKeyParts,
  RefSignatureEntry,
  StaleReason,
} from './signature.ts';
export { isPageRef, RefRegistry } from './registry.ts';
export type {
  NegotiateRefView,
  NegotiateResult,
  ObservationInput,
  ObservationRefInput,
  ObservationRegistration,
  RefEntry,
  RefRegistryOptions,
  RefResolveFailure,
  RefResolveResult,
  RefResolveSuccess,
  RegisterMeta,
} from './registry.ts';
