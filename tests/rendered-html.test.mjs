import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the classroom interpreter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>LinguaLive｜实时多语言翻译<\/title>/i);
  assert.match(html, /LinguaLive/);
  assert.match(html, /等待下一段语音/);
  assert.match(html, /开始同传/);
  assert.match(html, /英语与简体中文同步显示/);
  assert.match(html, /输入语言/);
  assert.match(html, /翻译为/);
  assert.match(html, /手动输入/);
  assert.match(html, /导览/);
  assert.match(html, /播报/);
  assert.match(html, /记录/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
