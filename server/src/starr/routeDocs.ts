/** What the route table knows about one route, for the generated OpenAPI document. */
export interface RouteDoc {
  method: "get" | "post" | "put" | "delete";
  path: string;
  summary: string;
  apps: Set<string>;
}

export const STARR_ROUTE_DOCS = new Map<string, RouteDoc>();
