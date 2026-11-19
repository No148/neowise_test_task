import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";

const silent = { warn() {}, error() {} };

async function startServer(options) {
  const server = createApp({ logger: silent, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/api/triage` };
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

describe("POST /api/triage с выданным имитатором", () => {
  let server, url;
  before(async () => ({ server, url } = await startServer()));
  after(() => server.close());

  test("корректный ответ модели → ready", async () => {
    const { status, body } = await post(url, { text: "Когда будет доставка?" });
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.ok(body.draft.trim().length > 0);
  });

  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`${marker} → manual_review`, async () => {
      const { status, body } = await post(url, { text: `Сколько стоит? ${marker}` });
      assert.equal(status, 200);
      assert.deepEqual(body, MANUAL_REVIEW);
    });
  }

  test("[timeout] → manual_review не дольше лимита в 300 мс", async () => {
    const started = performance.now();
    const { status, body } = await post(url, { text: "Где заказ? [timeout]" });
    const elapsed = performance.now() - started;
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
    assert.ok(elapsed < 800, `ответ пришёл через ${Math.round(elapsed)} мс`);
  });

  const invalidBodies = {
    "битый JSON": "{not json",
    "пустое тело": "",
    "нет поля text": {},
    "text не строка": { text: 42 },
    "text пустой": { text: "" },
    "text из пробелов": { text: "   " },
    "тело — массив": [],
    "тело — null": "null",
  };
  for (const [name, payload] of Object.entries(invalidBodies)) {
    test(`${name} → 400 invalid_input`, async () => {
      const { status, body } = await post(url, payload);
      assert.equal(status, 400);
      assert.deepEqual(body, { status: "invalid_input" });
    });
  }
});

describe("POST /api/triage с подменённой моделью", () => {
  test("модель игнорирует signal и висит → manual_review по таймауту", async () => {
    const hanging = () => new Promise(() => {});
    const { server, url } = await startServer({ classify: hanging, timeoutMs: 50 });
    try {
      const { status, body } = await post(url, { text: "Привет" });
      assert.equal(status, 200);
      assert.deepEqual(body, MANUAL_REVIEW);
    } finally {
      server.close();
    }
  });

  test("модель получает signal, и он отменяется по таймауту", async () => {
    let received;
    const classify = (_text, { signal }) => {
      received = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    };
    const { server, url } = await startServer({ classify, timeoutMs: 50 });
    try {
      const { body } = await post(url, { text: "Привет" });
      assert.deepEqual(body, MANUAL_REVIEW);
      assert.equal(received.aborted, true);
    } finally {
      server.close();
    }
  });
});
