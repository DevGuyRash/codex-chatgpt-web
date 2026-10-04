const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

// Resolve the packaging tool's downloader, not Electron's separate @electron/get 5.
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const getRequire = createRequire(builderRequire.resolve("@electron/get"));
const gotRequire = createRequire(getRequire.resolve("got"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request"));
const CachePolicy = cacheRequire("http-cache-semantics");

test("the locked cache policy rejects Vary wildcards and inherited request headers", () => {
  for (const vary of ["*", " * ", "*, accept-language", "accept-language, *"]) {
    const policy = new CachePolicy(
      { headers: { "accept-language": "en" } },
      { headers: { "cache-control": "max-age=60", vary } },
    );
    assert.equal(policy.satisfiesWithoutRevalidation({ headers: { "accept-language": "en" } }), false, vary);
  }
  const policy = new CachePolicy(
    { headers: { "accept-language": "en" } },
    { headers: { "cache-control": "max-age=60", vary: "accept-language" } },
  );
  assert.equal(policy.satisfiesWithoutRevalidation({ headers: { "accept-language": "en" } }), true);
  assert.equal(policy.satisfiesWithoutRevalidation({ headers: Object.create({ "accept-language": "en" }) }), false);
});

test("the build downloader makes fresh HTTP requests instead of consulting a shared HTTP cache", async () => {
  const { GotDownloader } = getRequire("./GotDownloader.js");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-download-test-"));
  let requests = 0;
  let cacheReads = 0;
  const original = CachePolicy.prototype.satisfiesWithoutRevalidation;
  CachePolicy.prototype.satisfiesWithoutRevalidation = function (...args) {
    cacheReads += 1;
    return original.apply(this, args);
  };
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, {
      "cache-control": "max-age=3600",
      "set-cookie": `synthetic-session=${requests}`,
    });
    response.end(`synthetic-artifact-${requests}`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/artifact`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const destination = path.join(scratch, `artifact-${attempt}`);
      await new GotDownloader().download(url, destination, {
        quiet: true,
        timeout: { request: 5000 },
        headers: { "cache-control": "max-stale=3600" },
      });
      assert.equal(fs.readFileSync(destination, "utf8"), `synthetic-artifact-${attempt}`);
    }
    assert.equal(requests, 2);
    assert.equal(cacheReads, 0);
    assert.equal(getRequire("got").defaults.options.cache, undefined);
  } finally {
    CachePolicy.prototype.satisfiesWithoutRevalidation = original;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("builder download options preserve the Got proxy, timeout and retry contract without HTTP caching", async () => {
  const get = builderRequire("@electron/get");
  const runtime = builderRequire("builder-util-runtime");
  const downloadArtifact = get.downloadArtifact;
  const retryDescriptor = Object.getOwnPropertyDescriptor(runtime, "retry");
  const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
  const savedProxy = Object.fromEntries(proxyNames.map(name => [name, process.env[name]]));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-builder-test-"));
  const fixture = path.join(scratch, "synthetic.zip");
  fs.writeFileSync(fixture, "synthetic artifact");
  const downloads = [];
  let retryOptions;
  get.downloadArtifact = async options => {
    downloads.push(options);
    return fixture;
  };
  Object.defineProperty(runtime, "retry", {
    configurable: true,
    value: async (operation, options) => {
      retryOptions = options;
      return operation();
    },
  });
  process.env.HTTP_PROXY = "http://127.0.0.1:18080";
  process.env.HTTPS_PROXY = "http://127.0.0.1:18443";
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  try {
    const builder = builderRequire("./out/util/electronGet.js");
    assert.equal(await builder.downloadElectronArtifactZip({
      artifactName: `launcher-fixture-${process.pid}`,
      version: "1.0.0",
      platformName: process.platform,
      arch: process.arch,
      cacheDir: scratch,
    }), fixture);
    assert.equal(downloads.length, 1);
    const options = downloads[0].downloadOptions;
    assert.equal(options.cache, undefined);
    assert.deepEqual(options.timeout, { request: 600000 });
    assert.equal(options.agent.http.proxy.href, "http://127.0.0.1:18080/");
    assert.equal(options.agent.https.proxy.href, "http://127.0.0.1:18443/");
    assert.equal(typeof options.getProgressCallback, "function");
    assert.equal(retryOptions.retries, 3);
    assert.equal(retryOptions.interval, 2000);
    assert.equal(retryOptions.backoff, 2000);
    assert.equal(retryOptions.shouldRetry({ response: { statusCode: 503 } }), true);
    assert.equal(retryOptions.shouldRetry({ response: { statusCode: 404 } }), false);
    assert.equal(retryOptions.shouldRetry({ code: "ETIMEDOUT" }), true);
    assert.equal(retryOptions.shouldRetry({ code: "ECONNRESET" }), true);
    assert.equal(retryOptions.shouldRetry({ code: "ERR_INVALID_ARG_TYPE" }), false);
  } finally {
    get.downloadArtifact = downloadArtifact;
    Object.defineProperty(runtime, "retry", retryDescriptor);
    for (const name of proxyNames) {
      if (savedProxy[name] === undefined) delete process.env[name];
      else process.env[name] = savedProxy[name];
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
