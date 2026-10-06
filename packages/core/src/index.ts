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
export { OVERLAY_SCRIPT, overlayStatusExpression } from './overlay/script.js';
export { createOriginPolicy } from './policy/origin.js';
export type { OriginPolicy } from './policy/origin.js';
