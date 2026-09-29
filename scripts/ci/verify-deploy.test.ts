import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./verify-deploy.sh", import.meta.url));

const PROD = "status.szolotov.com";
const STAGE = "stage.status.szolotov.com";
const PREVIEW = "stage.stage.status.szolotov.com";

const PROD_SAN = "DNS:status.szolotov.com, DNS:*.status.szolotov.com";

type Page = { status?: number; headers?: Record<string, string>; body?: string };
type Site = Record<string, Page>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A healthy production host: indexable, on version `v-prod`. */
function prodSite(): Site {
  return {
    "/": { headers: { "Content-Type": "text/html" }, body: "<html></html>" },
    "/healthz": { headers: { "X-Worker-Version": "v-prod" }, body: "ok" },
    "/readyz": { body: "ready" },
    "/robots.txt": { body: "User-agent: *\nAllow: /\n" },
  };
}

/** A healthy stage host: `noindex` on the page and `Disallow: /` in robots.txt. */
function stageSite(): Site {
  return {
    "/": { headers: { "X-Robots-Tag": "noindex, nofollow" }, body: "<html></html>" },
    "/healthz": { headers: { "X-Worker-Version": "v-stage" }, body: "ok" },
    "/readyz": { body: "ready" },
    "/robots.txt": { body: "User-agent: *\nDisallow: /\n" },
  };
}

type Options = {
  /** Replaces one page (or, with `null`, removes it so the host is unreachable). */
  pages?: Array<[host: string, path: string, page: Page | null]>;
  /** Extra hosts to serve, on top of prod and stage. */
  sites?: Record<string, Site>;
  san?: string;
  /** Exit code of `openssl x509 -checkend`: 1 means the certificate is expiring. */
  checkend?: number;
};

/** Writes the fixtures for one host: `<dir>/fx/<host>/<path with / as _>/{status,headers,body}`. */
function serve(fx: string, host: string, site: Site) {
  for (const [path, page] of Object.entries(site)) writePage(fx, host, path, page);
}

function writePage(fx: string, host: string, path: string, page: Page | null) {
  const dir = join(fx, host, path.replaceAll("/", "_"));
  if (page === null) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const status = page.status ?? 200;
  // What curl --dump-header writes: an HTTP/2 status line, then CRLF headers.
  const headers = Object.entries(page.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  writeFileSync(join(dir, "status"), String(status));
  writeFileSync(join(dir, "headers"), `HTTP/2 ${status}\r\ncontent-type: text/plain\r\n${headers}\r\n`);
  writeFileSync(join(dir, "body"), page.body ?? "");
}

/**
 * Runs the script against a fake `curl` and `openssl` that answer from the
 * fixtures for each host and path, and log every call they get.
 */
function run(args: string[], options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-deploy-"));
  dirs.push(dir);
  const fx = join(dir, "fx");
  mkdirSync(fx);
  serve(fx, PROD, prodSite());
  serve(fx, STAGE, stageSite());
  for (const [host, site] of Object.entries(options.sites ?? {})) serve(fx, host, site);
  for (const [host, path, page] of options.pages ?? []) writePage(fx, host, path, page);

  const bin = join(dir, "bin");
  mkdirSync(bin);
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/curl-calls"
hdr=; out=; url=
while [ $# -gt 0 ]; do
  case "$1" in
    --dump-header) hdr=$2; shift 2 ;;
    --output) out=$2; shift 2 ;;
    --max-time|--write-out) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
rest=\${url#*://}
host=\${rest%%/*}
case "$rest" in */*) path=/\${rest#*/} ;; *) path=/ ;; esac
key=$(printf '%s' "$path" | tr / _)
fixture="${fx}/$host/$key"
if [ ! -d "$fixture" ]; then
  echo "curl: (6) Could not resolve host: $host" >&2
  printf '000'
  exit 6
fi
[ -n "$hdr" ] && cp "$fixture/headers" "$hdr"
[ -n "$out" ] && cp "$fixture/body" "$out"
printf '%s' "$(cat "$fixture/status")"
`,
  );
  const openssl = join(bin, "openssl");
  writeFileSync(
    openssl,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/openssl-calls"
case "$1" in
  s_client)
    printf -- '-----BEGIN CERTIFICATE-----\\nZmFrZQ==\\n-----END CERTIFICATE-----\\n'
    ;;
  x509)
    cat > /dev/null
    printf 'X509v3 Subject Alternative Name: \\n    %s\\n' "$FAKE_SAN"
    if [ "\${FAKE_CHECKEND:-0}" = 0 ]; then echo "Certificate will not expire"; else echo "Certificate will expire"; fi
    exit "\${FAKE_CHECKEND:-0}"
    ;;
esac
`,
  );
  chmodSync(curl, 0o755);
  chmodSync(openssl, 0o755);

  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_SAN: options.san ?? PROD_SAN,
      FAKE_CHECKEND: String(options.checkend ?? 0),
    },
  });
  const log = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n") : [];
  const output = `${result.stdout}${result.stderr}`;
  const lines = output.split("\n");
  const summary = output.match(/verify-deploy: (\d+) checks?, (\d+) failed/);
  return {
    status: result.status,
    output,
    /** `ok` lines for one target, and `FAIL` lines for one target. */
    ok: (target?: string) =>
      lines.filter((line) => line.startsWith("ok ") && (!target || line.includes(` ${target} `))),
    fails: (target?: string) =>
      lines.filter((line) => line.startsWith("FAIL ") && (!target || line.includes(` ${target} `))),
    checks: summary ? Number(summary[1]) : Number.NaN,
    failed: summary ? Number(summary[2]) : Number.NaN,
    curlCalls: log("curl-calls"),
    opensslCalls: log("openssl-calls"),
  };
}

describe("verify-deploy.sh", () => {
  it("passes on a healthy production and stage", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.fails()).toEqual([]);
    expect(r.failed).toBe(0);
    expect(r.ok("prod").length).toBeGreaterThan(0);
    expect(r.ok("stage").length).toBeGreaterThan(0);
    expect(r.checks).toBe(r.ok().length);
    // The same checks run on both hosts.
    expect(r.ok("prod")).toHaveLength(r.ok("stage").length);
  });

  it("checks the given URLs and passes the timeout to curl", () => {
    const r = run(["--timeout", "3"]);
    expect(r.curlCalls.length).toBeGreaterThan(0);
    for (const call of r.curlCalls) expect(call).toContain("--max-time 3");
    expect(r.curlCalls.some((call) => call.includes(`https://${PROD}/healthz`))).toBe(true);
    expect(r.curlCalls.some((call) => call.includes(`https://${STAGE}/readyz`))).toBe(true);
  });

  it("uses a 15 second timeout by default", () => {
    const r = run([]);
    for (const call of r.curlCalls) expect(call).toContain("--max-time 15");
  });

  it("reads X-Worker-Version whatever the case of the header name", () => {
    const r = run([], { pages: [[PROD, "/healthz", { headers: { "x-worker-version": "v-prod" } }]] });
    expect(r.status).toBe(0);
  });

  it("takes other URLs for production and stage", () => {
    const other = "board.example.org";
    const r = run(["--prod-url", `https://${other}`, "--stage-url", `https://stage.${other}/`], {
      sites: { [other]: prodSite(), [`stage.${other}`]: stageSite() },
      san: `DNS:${other}, DNS:*.${other}`,
    });
    expect(r.status).toBe(0);
    expect(r.curlCalls.every((call) => !call.includes(PROD))).toBe(true);
    expect(r.opensslCalls.some((call) => call.includes(`${other}:443`) && call.includes(`-servername ${other}`))).toBe(
      true,
    );
  });

  describe("robots.txt", () => {
    it("fails on stage when robots.txt allows crawling", () => {
      const r = run([], { pages: [[STAGE, "/robots.txt", { body: "User-agent: *\nAllow: /\n" }]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("robots");
      expect(r.fails("prod")).toEqual([]);
    });

    it("fails on production when robots.txt disallows everything", () => {
      const r = run([], { pages: [[PROD, "/robots.txt", { body: "User-agent: *\nDisallow: /\n" }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("robots");
    });

    it("fails on production when robots.txt has Allow: / and also Disallow: /", () => {
      const r = run([], { pages: [[PROD, "/robots.txt", { body: "User-agent: *\nAllow: /\nDisallow: /\n" }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
    });
  });

  describe("X-Robots-Tag", () => {
    it("fails on production when the page sends X-Robots-Tag", () => {
      const r = run([], { pages: [[PROD, "/", { headers: { "X-Robots-Tag": "noindex, nofollow" } }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0].toLowerCase()).toContain("x-robots-tag");
      expect(r.fails("stage")).toEqual([]);
    });

    it("fails on stage when the page sends no X-Robots-Tag", () => {
      const r = run([], { pages: [[STAGE, "/", {}]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0].toLowerCase()).toContain("x-robots-tag");
    });

    it("fails on stage when X-Robots-Tag is not exactly noindex, nofollow", () => {
      const r = run([], { pages: [[STAGE, "/", { headers: { "X-Robots-Tag": "noindex" } }]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("noindex");
    });
  });

  describe("X-Worker-Version", () => {
    it("fails when /healthz sends no X-Worker-Version", () => {
      const r = run([], { pages: [[STAGE, "/healthz", {}]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("/healthz");
      expect(r.fails("prod")).toEqual([]);
    });

    it("fails when X-Worker-Version is empty", () => {
      const r = run([], { pages: [[PROD, "/healthz", { headers: { "X-Worker-Version": "" } }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
    });

    it("passes when production runs the expected version", () => {
      const r = run(["--expect-version", "v-prod"]);
      expect(r.status).toBe(0);
    });

    it("fails when production runs another version, and names both", () => {
      const r = run(["--expect-version", "v-new"]);
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("v-new");
      expect(r.fails("prod")[0]).toContain("v-prod");
    });

    it("does not compare the expected version with stage", () => {
      // Stage answers v-stage while --expect-version asks for the production id.
      const r = run(["--expect-version", "v-prod"]);
      expect(r.fails("stage")).toEqual([]);
    });
  });

  describe("status codes", () => {
    it("fails when /readyz answers 503", () => {
      const r = run([], { pages: [[PROD, "/readyz", { status: 503 }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("/readyz");
      expect(r.fails("prod")[0]).toContain("503");
      expect(r.failed).toBe(1);
    });

    it("fails when the page answers 500", () => {
      const r = run([], { pages: [[STAGE, "/", { status: 500, headers: { "X-Robots-Tag": "noindex, nofollow" } }]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("500");
    });

    it("fails, without stopping, when a host does not answer", () => {
      const r = run([], {
        pages: [
          [STAGE, "/", null],
          [STAGE, "/healthz", null],
          [STAGE, "/readyz", null],
          [STAGE, "/robots.txt", null],
        ],
      });
      expect(r.status).toBe(1);
      expect(r.fails("stage").length).toBeGreaterThanOrEqual(4);
      expect(r.ok("prod").length).toBeGreaterThan(0);
      expect(r.fails("prod")).toEqual([]);
    });
  });

  describe("TLS", () => {
    it("checks the certificate the host serves for its own name", () => {
      const r = run([]);
      expect(r.opensslCalls.some((c) => c.includes(`s_client`) && c.includes(`-connect ${PROD}:443`))).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes(`-servername ${STAGE}`))).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes("x509") && c.includes("-checkend 604800"))).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes("x509") && c.includes("subjectAltName"))).toBe(true);
    });

    it("fails a host whose name the certificate does not list, and names the host", () => {
      // Covers production only: stage sits one label below it.
      const r = run([], { san: "DNS:status.szolotov.com" });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toEqual([]);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain(STAGE);
    });

    it("accepts a single-label wildcard for the host", () => {
      const r = run([], { san: "DNS:*.szolotov.com, DNS:*.status.szolotov.com" });
      expect(r.fails("stage")).toEqual([]);
      // *.szolotov.com covers status.szolotov.com, *.status.szolotov.com covers stage.status.szolotov.com.
      expect(r.status).toBe(0);
    });

    it("accepts a certificate that lists only a wildcard for the host", () => {
      const r = run(["--only", "stage"], { san: "DNS:*.status.szolotov.com" });
      expect(r.status).toBe(0);
    });

    it("does not let a wildcard cover a name two labels below it", () => {
      const r = run(["--only", "stage", "--stage-url", `https://${PREVIEW}`], {
        sites: { [PREVIEW]: stageSite() },
        san: "DNS:*.status.szolotov.com",
      });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain(PREVIEW);
    });

    it("does not let a wildcard cover the bare domain it is a wildcard for", () => {
      const r = run(["--only", "prod"], { san: "DNS:*.status.szolotov.com" });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain(PROD);
    });

    it("fails a certificate that expires within seven days", () => {
      const r = run([], { checkend: 1 });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("prod")[0].toLowerCase()).toMatch(/expir/);
    });

    it("skips TLS with --skip-tls", () => {
      const withTls = run([]);
      const r = run(["--skip-tls"], { san: "DNS:nothing.example.org", checkend: 1 });
      expect(r.status).toBe(0);
      expect(r.opensslCalls).toEqual([]);
      expect(r.checks).toBeLessThan(withTls.checks);
    });
  });

  describe("--only", () => {
    it("checks production alone", () => {
      const r = run(["--only", "prod"]);
      expect(r.status).toBe(0);
      expect(r.ok("prod").length).toBeGreaterThan(0);
      expect(r.output).not.toMatch(/\bstage\b/);
      expect(r.curlCalls.every((call) => call.includes(`https://${PROD}/`))).toBe(true);
    });

    it("checks stage alone", () => {
      const r = run(["--only", "stage"]);
      expect(r.status).toBe(0);
      expect(r.ok("stage").length).toBeGreaterThan(0);
      expect(r.output).not.toMatch(/\bprod\b/);
      expect(r.curlCalls.every((call) => call.includes(`https://${STAGE}/`))).toBe(true);
    });

    it("ignores a broken host it was not asked to check", () => {
      const r = run(["--only", "prod"], { pages: [[STAGE, "/readyz", { status: 503 }]] });
      expect(r.status).toBe(0);
    });
  });

  it("goes on with the later checks after a failure", () => {
    const r = run([], {
      pages: [
        [PROD, "/", { status: 500 }],
        [PROD, "/readyz", { status: 503 }],
        [STAGE, "/readyz", { status: 503 }],
      ],
    });
    expect(r.status).toBe(1);
    expect(r.failed).toBe(r.fails().length);
    expect(r.fails("prod").length).toBeGreaterThanOrEqual(2);
    expect(r.fails("stage")).toHaveLength(1);
    // Checks after the failed ones still ran and passed, on both hosts, TLS last.
    expect(r.ok("prod").some((line) => line.includes("/healthz"))).toBe(true);
    expect(r.ok("prod").some((line) => line.includes("/robots.txt"))).toBe(true);
    expect(r.ok("stage").some((line) => line.includes("/robots.txt"))).toBe(true);
    expect(r.opensslCalls.length).toBeGreaterThanOrEqual(2);
    expect(r.checks).toBe(r.ok().length + r.fails().length);
  });

  describe("bad usage", () => {
    for (const [name, args] of [
      ["an unknown option", ["--frobnicate"]],
      ["an unexpected argument", ["https://status.szolotov.com"]],
      ["--only with another value", ["--only", "both"]],
      ["--only without a value", ["--only"]],
      ["--prod-url without a value", ["--prod-url"]],
      ["a --timeout that is not a number", ["--timeout", "soon"]],
      ["a --timeout of zero", ["--timeout", "0"]],
    ] as const) {
      it(`exits 2 on ${name}, without checking anything`, () => {
        const r = run([...args]);
        expect(r.status).toBe(2);
        expect(r.output.toLowerCase()).toMatch(/usage|error/);
        expect(r.curlCalls).toEqual([]);
        expect(r.opensslCalls).toEqual([]);
      });
    }
  });
});
