import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

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

let toolsDir: string | undefined;
afterAll(() => {
  if (toolsDir) rmSync(toolsDir, { recursive: true, force: true });
});

/**
 * A directory of symlinks to every system command except `timeout` and
 * `gtimeout`, so a run can put it on PATH and have neither of them.
 */
function commandsWithoutTimeout(): string {
  if (toolsDir) return toolsDir;
  toolsDir = mkdtempSync(join(tmpdir(), "verify-deploy-tools-"));
  const seen = new Set(["timeout", "gtimeout"]);
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (seen.has(name)) continue;
      seen.add(name);
      symlinkSync(join(dir, name), join(toolsDir, name));
    }
  }
  return toolsDir;
}

const hasPerl = spawnSync("perl", ["-e", "1"]).status === 0;

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
  /** Extra environment for the fakes: `FAKE_NOCERT=1` (openssl prints no certificate), `FAKE_HANG=1` (openssl hangs). */
  env?: Record<string, string>;
  /** Puts a `timeout` on PATH that exits with this code without running anything. */
  timeoutExit?: number;
  /** Runs with neither `timeout` nor `gtimeout` on PATH, so the script must fall back. */
  noTimeout?: boolean;
  /** With `noTimeout`: puts a fake `gtimeout`, which logs its call and runs the command, on PATH. */
  gtimeout?: boolean;
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
host=\${host##*@}
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
  // What OpenSSL 3 prints for `x509 -noout -text -checkend`: the whole
  // certificate as text (the SAN extension name, then its entries on the next
  // line), then the checkend verdict, and exit status 1 when it is expiring.
  writeFileSync(
    openssl,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/openssl-calls"
case "$1" in
  s_client)
    [ -n "$FAKE_HANG" ] && sleep 5
    [ -n "$FAKE_NOCERT" ] && exit 1
    printf 'CONNECTED(00000003)\\n'
    printf -- '-----BEGIN CERTIFICATE-----\\nZmFrZQ==\\n-----END CERTIFICATE-----\\n'
    ;;
  x509)
    cat > /dev/null
    if [ -n "$FAKE_NOCERT" ]; then
      echo "Could not read certificate from <stdin>" >&2
      exit 1
    fi
    printf 'Certificate:\\n    Data:\\n        Version: 3 (0x2)\\n'
    printf '        Signature Algorithm: ecdsa-with-SHA256\\n'
    printf '        Issuer: C = US, O = Example Trust, CN = EX1\\n'
    printf '        Validity\\n            Not Before: Sep  1 00:00:00 2026 GMT\\n            Not After : Nov 30 00:00:00 2026 GMT\\n'
    printf '        Subject: CN = ca-issued.example.net\\n'
    printf '        X509v3 extensions:\\n'
    printf '            X509v3 Key Usage: critical\\n                Digital Signature\\n'
    printf '            X509v3 Extended Key Usage: \\n                TLS Web Server Authentication\\n'
    printf '            X509v3 Subject Alternative Name: \\n                %s\\n' "$FAKE_SAN"
    printf '            Authority Information Access: \\n                CA Issuers - URI:http://i.example.net/ex1.crt\\n'
    printf '            X509v3 CRL Distribution Points: \\n                Full Name:\\n                  URI:http://c.example.net/ex1.crl\\n'
    printf '    Signature Algorithm: ecdsa-with-SHA256\\n    Signature Value:\\n        30:45:02:20:1a:2b\\n'
    if [ "\${FAKE_CHECKEND:-0}" = 0 ]; then echo "Certificate will not expire"; else echo "Certificate will expire"; fi
    exit "\${FAKE_CHECKEND:-0}"
    ;;
esac
`,
  );
  chmodSync(curl, 0o755);
  chmodSync(openssl, 0o755);
  if (options.timeoutExit !== undefined) {
    const stub = join(bin, "timeout");
    writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${dir}/timeout-calls"\nexit ${options.timeoutExit}\n`);
    chmodSync(stub, 0o755);
  }
  if (options.gtimeout) {
    const stub = join(bin, "gtimeout");
    writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${dir}/gtimeout-calls"\nshift\nexec "$@"\n`);
    chmodSync(stub, 0o755);
  }

  const started = Date.now();
  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${options.noTimeout ? commandsWithoutTimeout() : process.env.PATH}`,
      FAKE_SAN: options.san ?? PROD_SAN,
      FAKE_CHECKEND: String(options.checkend ?? 0),
      ...options.env,
    },
  });
  const elapsed = Date.now() - started;
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
    /** The URL each curl call fetched, parsed, so tests compare hosts and paths exactly. */
    curlUrls: log("curl-calls").flatMap((call) => {
      const url = URL.parse(call.trim().split(/\s+/).at(-1) ?? "");
      return url ? [url] : [];
    }),
    opensslCalls: log("openssl-calls"),
    timeoutCalls: log("timeout-calls"),
    gtimeoutCalls: log("gtimeout-calls"),
    /** Milliseconds the script ran for. */
    elapsed,
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
    expect(r.curlUrls.some((url) => url.hostname === PROD && url.pathname === "/healthz")).toBe(true);
    expect(r.curlUrls.some((url) => url.hostname === STAGE && url.pathname === "/readyz")).toBe(true);
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
    expect(r.curlUrls.every((url) => url.hostname !== PROD)).toBe(true);
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

    it("reads a robots.txt with CRLF line endings", () => {
      const r = run([], {
        pages: [
          [PROD, "/robots.txt", { body: "User-agent: *\r\nAllow: /\r\n" }],
          [STAGE, "/robots.txt", { body: "User-agent: *\r\nDisallow: /\r\n" }],
        ],
      });
      expect(r.status).toBe(0);
    });

    it("still sees Disallow: / in a CRLF robots.txt on production", () => {
      const r = run([], { pages: [[PROD, "/robots.txt", { body: "User-agent: *\r\nDisallow: /\r\n" }]] });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("robots");
    });

    it("fails on stage when robots.txt only disallows a path below /", () => {
      const r = run([], { pages: [[STAGE, "/robots.txt", { body: "User-agent: *\nDisallow: /private\n" }]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("robots");
    });

    it("passes on production when robots.txt only disallows a path below /", () => {
      const r = run([], {
        pages: [[PROD, "/robots.txt", { body: "User-agent: *\nAllow: /\nDisallow: /private\n" }]],
      });
      expect(r.status).toBe(0);
    });

    it("passes on production when only another crawler is disallowed", () => {
      const body = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
      const r = run([], { pages: [[PROD, "/robots.txt", { body }]] });
      expect(r.status).toBe(0);
      expect(r.fails("prod")).toEqual([]);
    });

    it("fails on stage when only another crawler is disallowed", () => {
      const body = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
      const r = run([], { pages: [[STAGE, "/robots.txt", { body }]] });
      expect(r.status).toBe(1);
      expect(r.fails("stage")).toHaveLength(1);
      expect(r.fails("stage")[0]).toContain("robots");
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

  it("trims tabs around a header value", () => {
    const r = run([], { pages: [[STAGE, "/", { headers: { "X-Robots-Tag": "\tnoindex, nofollow\t" } }]] });
    expect(r.status).toBe(0);
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

    it("exits 2 on an --expect-version that is not a version id", () => {
      const r = run(["--expect-version", "not a version!"]);
      expect(r.status).toBe(2);
      expect(r.output).toContain("--expect-version");
      expect(r.curlCalls).toEqual([]);
      expect(r.opensslCalls).toEqual([]);
    });

    it("exits 2 on --expect-version with --only stage, without checking anything", () => {
      const r = run(["--only", "stage", "--expect-version", "v-prod"]);
      expect(r.status).toBe(2);
      expect(r.output).toContain("--expect-version");
      expect(r.curlCalls).toEqual([]);
      expect(r.opensslCalls).toEqual([]);
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
      expect(r.opensslCalls.some((c) => c.includes("x509") && c.includes("-noout -text -checkend 604800"))).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes("x509") && c.includes("-ext"))).toBe(false);
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

    it("fails, saying so, when openssl reads no certificate", () => {
      const r = run(["--only", "prod"], { env: { FAKE_NOCERT: "1" } });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("could not read a certificate");
      expect(r.fails("prod")[0]).toContain(`${PROD}:443`);
      expect(r.output).not.toMatch(/expire/i);
    });

    it("does not read the certificate's subject as a name it covers", () => {
      const r = run(["--only", "prod"], { san: "DNS:other.example.org" });
      expect(r.status).toBe(1);
      expect(r.fails("prod")[0]).toContain(PROD);
    });

    it("passes the port of the URL to openssl, and the bare host as the server name", () => {
      const other = "board.example.org";
      const r = run(["--only", "prod", "--prod-url", `https://${other}:8443`], {
        sites: { [`${other}:8443`]: prodSite() },
        san: `DNS:${other}`,
      });
      expect(r.status).toBe(0);
      expect(
        r.opensslCalls.some((c) => c.includes(`-connect ${other}:8443`) && c.includes(`-servername ${other}`)),
      ).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes(":443"))).toBe(false);
    });

    it("connects to an IPv6 literal with its port and sends no server name", () => {
      const r = run(["--only", "prod", "--prod-url", "https://[::1]:8443"], {
        sites: { "[::1]:8443": prodSite() },
      });
      expect(r.opensslCalls.some((c) => c.includes("-connect [::1]:8443"))).toBe(true);
      expect(r.opensslCalls.some((c) => c.includes("-servername"))).toBe(false);
    });

    it("fails the TLS check, naming the port, when the URL has an invalid one", () => {
      const r = run(["--only", "prod", "--prod-url", `https://${PROD}:abc`], {
        sites: { [`${PROD}:abc`]: prodSite() },
      });
      expect(r.status).toBe(1);
      expect(r.fails("prod").some((line) => line.includes("tls") && line.includes('invalid port "abc"'))).toBe(true);
      expect(r.opensslCalls).toEqual([]);
    });

    it("leaves the userinfo of a URL out of the TLS check", () => {
      const r = run(["--only", "prod", "--prod-url", `https://someone:secret@${PROD}`]);
      expect(r.status).toBe(0);
      expect(r.opensslCalls.some((c) => c.includes(`-connect ${PROD}:443`) && c.includes(`-servername ${PROD}`))).toBe(
        true,
      );
      expect(r.opensslCalls.join("\n")).not.toContain("secret");
      expect(r.output).not.toContain("secret");
    });

    it("gives no wildcard hint for a host without a dot", () => {
      const r = run(["--only", "prod", "--prod-url", "https://localhost"], {
        sites: { localhost: prodSite() },
        // A wildcard never covers a single label, whatever it is a wildcard for.
        san: "DNS:*.localhost, DNS:other.example.org",
      });
      expect(r.status).toBe(1);
      expect(r.fails("prod")).toHaveLength(1);
      expect(r.fails("prod")[0]).toContain("localhost");
      expect(r.fails("prod")[0]).not.toContain("*");
    });

    describe("timeout", () => {
      it("reports a certificate check that timed out, not an unreadable certificate", () => {
        const r = run(["--only", "prod", "--timeout", "3"], { timeoutExit: 124 });
        expect(r.status).toBe(1);
        expect(r.timeoutCalls.length).toBeGreaterThan(0);
        expect(r.timeoutCalls[0]).toMatch(/^3\b/);
        expect(r.fails("prod")).toHaveLength(1);
        expect(r.fails("prod")[0]).toContain("timed out after 3s");
        expect(r.fails("prod")[0]).not.toContain("could not read");
      });

      it("stops a hung TLS handshake after --timeout seconds", () => {
        const r = run(["--only", "prod", "--timeout", "1"], { env: { FAKE_HANG: "1" } });
        expect(r.status).toBe(1);
        expect(r.fails("prod")).toHaveLength(1);
        expect(r.fails("prod")[0]).toContain("timed out after 1s");
        // The fake hangs for 5 s: the script must not wait for it.
        expect(r.elapsed).toBeLessThan(4500);
      });

      it("uses gtimeout when there is no timeout", () => {
        const r = run(["--only", "prod", "--timeout", "7"], { noTimeout: true, gtimeout: true });
        expect(r.status).toBe(0);
        expect(r.gtimeoutCalls).toHaveLength(1);
        expect(r.gtimeoutCalls[0]).toMatch(/^7\b/);
      });

      it.skipIf(!hasPerl)("falls back to perl when there is neither timeout nor gtimeout", () => {
        const r = run(["--only", "prod"], { noTimeout: true });
        expect(r.status).toBe(0);
        expect(r.ok("prod").some((line) => line.includes("tls"))).toBe(true);
      });

      it.skipIf(!hasPerl)("times out a hung handshake without timeout and gtimeout", () => {
        const r = run(["--only", "prod", "--timeout", "1"], { noTimeout: true, env: { FAKE_HANG: "1" } });
        expect(r.status).toBe(1);
        expect(r.fails("prod")).toHaveLength(1);
        expect(r.fails("prod")[0]).toContain("timed out after 1s");
        expect(r.elapsed).toBeLessThan(4500);
      });
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
      expect(r.curlUrls.every((url) => url.protocol === "https:" && url.hostname === PROD)).toBe(true);
    });

    it("checks stage alone", () => {
      const r = run(["--only", "stage"]);
      expect(r.status).toBe(0);
      expect(r.ok("stage").length).toBeGreaterThan(0);
      expect(r.output).not.toMatch(/\bprod\b/);
      expect(r.curlUrls.every((url) => url.protocol === "https:" && url.hostname === STAGE)).toBe(true);
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
