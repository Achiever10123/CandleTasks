const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const stub = {
  app: { getVersion: () => "1.1.0", isPackaged: true },
  net: {},
  Notification: function () {},
  shell: {},
};
const orig = Module._load;
Module._load = function (req, ...rest) {
  return req === "electron" ? stub : orig.call(this, req, ...rest);
};
const { _internal: u } = require("../updater.js");
Module._load = orig;

test("cleanVer accepts plain versions and a leading v, rejects anything else", () => {
  assert.equal(u.cleanVer("1.2.3"), "1.2.3");
  assert.equal(u.cleanVer("v1.2.3"), "1.2.3");
  assert.equal(u.cleanVer("1.2.3-beta.1"), "1.2.3-beta.1");
  for (const bad of [
    "",
    "latest",
    "1.2",
    "<img src=x onerror=alert(1)>",
    "1.2.3<script>",
    null,
    undefined,
    5,
    {},
  ]) {
    assert.equal(u.cleanVer(bad), null);
  }
});
test("isNewer compares numerically, not as strings", () => {
  assert.equal(u.isNewer("1.10.0", "1.9.0"), true);
  assert.equal(u.isNewer("1.1.1", "1.1.0"), true);
  assert.equal(u.isNewer("2.0.0", "1.99.99"), true);
  assert.equal(u.isNewer("1.1.0", "1.1.0"), false);
  assert.equal(u.isNewer("1.0.9", "1.1.0"), false);
  assert.equal(u.isNewer("1.2.0-beta", "1.2.0"), false);
});
test("parseRepo reads package.json build.publish and rejects the placeholder", () => {
  const ok = {
    build: {
      publish: [{ provider: "github", owner: "jane", repo: "candletasks" }],
    },
  };
  assert.deepEqual(u.parseRepo(ok), { owner: "jane", repo: "candletasks" });
  assert.equal(
    u.parseRepo({
      build: {
        publish: [
          { provider: "github", owner: "YOUR_GITHUB_USERNAME", repo: "x" },
        ],
      },
    }),
    null,
  );
  assert.equal(
    u.parseRepo({
      build: { publish: [{ provider: "github", owner: "a/b", repo: "x" }] },
    }),
    null,
  );
  assert.equal(
    u.parseRepo({
      build: { publish: [{ provider: "s3", owner: "a", repo: "x" }] },
    }),
    null,
  );
  assert.equal(u.parseRepo({}), null);
  assert.equal(u.parseRepo(null), null);
});
