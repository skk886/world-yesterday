import type { APIRoute, GetStaticPaths } from "astro";
import { loadEditions } from "../../lib/data";
export const getStaticPaths = (() => loadEditions().map((edition) => ({ params: { date: edition.date }, props: { edition } }))) satisfies GetStaticPaths;
export const GET: APIRoute = ({ props }) => new Response(JSON.stringify(props.edition, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=3600" }
});
