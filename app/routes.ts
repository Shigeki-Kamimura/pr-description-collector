import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
	index("routes/_index.tsx"),
	route("api/collect", "routes/api.collect.tsx"),
] satisfies RouteConfig;
