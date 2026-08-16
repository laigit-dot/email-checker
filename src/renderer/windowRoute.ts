export type WindowRoute = "main" | "floating" | "sidebar" | "peek";

const WINDOW_ROUTES = new Set<WindowRoute>([
  "main",
  "floating",
  "sidebar",
  "peek",
]);

export function selectWindowRoute(search: string): WindowRoute {
  const route = new URLSearchParams(search).get("window");
  return route && WINDOW_ROUTES.has(route as WindowRoute)
    ? (route as WindowRoute)
    : "main";
}
