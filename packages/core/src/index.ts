export type {
  BrowserError,
  BrowserErrorCode,
  BrowserKind,
  DriverCapabilities,
  Endpoint,
  Engine,
  Observation,
  RefLine,
  Result,
} from './types.js';
export type { Action, BrowserDriver, ConnectMode, ObserveOptions, SessionInfo, Target } from './driver.js';
export { findRef, parseSnapshotTree } from './snapshot/tree.js';
export {
  chromiumUserDataDirs,
  discoverEndpoints,
  firefoxProfileRoots,
  isWsl,
  parseDevToolsActivePort,
  parseWebDriverBiDiServer,
  wslWindowsUserDataDirs,
} from './discovery/endpoints.js';
export type { HostInfo } from './discovery/endpoints.js';
export { buildOverlayScript, overlayCall, parseOverlayDrain, parseTargetFacts } from './overlay/script.js';
export type { OverlayDrain } from './overlay/script.js';
export { InteractionLease } from './lease/lease.js';
export type { ControlState, LeaseSnapshot, OverlayEvent, OverlayEventType } from './lease/lease.js';
export { createOriginPolicy } from './policy/origin.js';
export type { OriginPolicy } from './policy/origin.js';
export { assessAction, describeAction } from './policy/risk.js';
export type { AssessContext, Assessment, Reason, RiskLevel, TargetFacts } from './policy/risk.js';
export { APPROVAL_MODES, isApprovalMode, requiresApproval } from './policy/mode.js';
export type { ApprovalMode } from './policy/mode.js';
export { TaintTracker } from './policy/taint.js';
