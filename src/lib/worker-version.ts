// Which Worker version answered a request. wrangler.jsonc binds the version
// metadata as CF_VERSION_METADATA, and src/server.cloudflare.ts copies its
// id onto every response, so deploy.yml's smoke test can wait until the
// version it just deployed is the one answering (scripts/ci/smoke.sh
// --expect-version) instead of passing or failing on the one before it.
// The id is the same one `wrangler deployments list` and the dashboard show,
// and names nothing but the version. Platform-neutral: the Node build never
// calls it.

export const WORKER_VERSION_HEADER = "X-Worker-Version";

/** A copy of `response` carrying X-Worker-Version, or `response` itself when there is no id. */
export function withWorkerVersion(response: Response, versionId: string | undefined): Response {
  if (!versionId) return response;
  const copy = new Response(response.body, response);
  copy.headers.set(WORKER_VERSION_HEADER, versionId);
  return copy;
}
