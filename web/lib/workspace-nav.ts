// GSD Web — Machine workspace nav registry (per-surface feature selection).
//
// The machine workspace UI ships in two places: the bundled web (`gsd --web`
// against a local machine) and the SaaS web (the same UI hosted inside
// gsd-cloud). Entries declare which surfaces they belong to, so a feature can
// exist in one and not the other.
//
// Host apps append their own entries through the `extraItems` prop on
// GSDAppShell rather than editing the registry: this module and the sidebar
// are vendored into gsd-cloud (docs/dev/gsd-web-vendoring.md there), so edits
// made on the cloud side are overwritten by the next sync.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Columns2,
  Folder,
  LayoutDashboard,
  Map as MapIcon,
  MessagesSquare,
} from "lucide-react";

import { isCloudModeClient } from "./cloud-client.ts";

/** Which app a nav entry belongs to. */
export type NavSurface = "bundled" | "saas";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Surfaces this entry appears on. Omit for both. */
  surfaces?: NavSurface[];
  /** When set, selecting the entry navigates here instead of switching view. */
  href?: string;
}

/** The built-in workspace views — the single source for every nav renderer. */
export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "power", label: "Power Mode", icon: Columns2 },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "roadmap", label: "Roadmap", icon: MapIcon },
  { id: "files", label: "Files", icon: Folder },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "visualize", label: "Visualize", icon: BarChart3 },
];

export function currentNavSurface(): NavSurface {
  return isCloudModeClient() ? "saas" : "bundled";
}

/**
 * Registry entries visible on `surface`, followed by any host-supplied extras.
 * Ids are unique: an extra with a new id is appended after the built-ins, but an
 * extra reusing an existing id overrides that entry in place (keeping its
 * original position) rather than adding a second row.
 */
export function resolveNavItems(
  extraItems: NavItem[] = [],
  surface: NavSurface = currentNavSurface(),
): NavItem[] {
  const visible = [...NAV_ITEMS, ...extraItems].filter(
    (item) => !item.surfaces || item.surfaces.includes(surface),
  );
  // De-duplicate by id so a host reusing an existing id (or duplicating within
  // extras) can't produce duplicate React keys (`key={item.id}`) and the unstable
  // rendering/selection that follows. A Map keeps each id at its first position
  // while letting a later entry override the value: last item wins, order preserved.
  const byId = new Map<string, NavItem>();
  for (const item of visible) byId.set(item.id, item);
  return [...byId.values()];
}

/** Selecting an entry navigates when it carries an href, otherwise switches view. */
export function selectNavItem(item: NavItem, onViewChange: (view: string) => void): void {
  if (item.href) {
    if (typeof window === "undefined") {
      // href entries navigate the browser; there is nothing to navigate outside one.
      // Fail with a clear message instead of a bare ReferenceError on `window`.
      throw new Error(
        `selectNavItem: cannot navigate to "${item.href}" outside a browser (window is undefined).`,
      );
    }
    window.location.href = item.href;
    return;
  }
  onViewChange(item.id);
}
