declare const __EV_API_BASE__: string | undefined;

/** Pages uses the live data server; the hosted app keeps same-origin requests. */
export function apiUrl(path: string, base = typeof __EV_API_BASE__ === "string" ? __EV_API_BASE__ : ""): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}
