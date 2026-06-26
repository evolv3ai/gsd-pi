// Project/App: gsd-pi
// File Purpose: Public exports for the gsd-core compat module.
export {
  COMPAT_MARKER_SCHEMA,
  EMPTY_MARKER,
  compatMarkerPath,
  computeProjectionSha,
  normalizeForHash,
  readCompatMarker,
  writeCompatMarker,
} from "./compat-marker.js";
export type { CompatMarker, PlanningLayout, PlanningMarker, ProjectionEntry } from "./compat-marker.js";
