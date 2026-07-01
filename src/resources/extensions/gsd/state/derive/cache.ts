// Project/App: gsd-pi
// File Purpose: deriveState memoization cache and telemetry.

import type { GSDState } from '../../types.js';

interface StateCache {
  basePath: string;
  result: GSDState;
  timestamp: number;
}

const CACHE_TTL_MS = 100;
let _stateCache: StateCache | null = null;

let _telemetry = { dbDeriveCount: 0 };

export function getDeriveTelemetry() {
  return { ..._telemetry };
}

export function resetDeriveTelemetry() {
  _telemetry = { dbDeriveCount: 0 };
}

export function incrementDbDeriveCount(): void {
  _telemetry.dbDeriveCount++;
}

export function invalidateStateCache(): void {
  _stateCache = null;
}

export function readCachedDeriveState(cacheKey: string): GSDState | null {
  if (
    _stateCache &&
    _stateCache.basePath === cacheKey &&
    Date.now() - _stateCache.timestamp < CACHE_TTL_MS
  ) {
    return _stateCache.result;
  }
  return null;
}

export function writeCachedDeriveState(cacheKey: string, result: GSDState): void {
  _stateCache = { basePath: cacheKey, result, timestamp: Date.now() };
}
