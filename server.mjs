import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const TOPICS = new Set(["delivery", "pricing", "other"]);

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Возвращает текст заявки или null, если вход некорректен. */
export function parseInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/** Проверяет ответ модели. Возвращает { topic, draft } или null, если ответ нельзя показать. */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

/** Вызывает модель с жёстким лимитом: отменяет запрос через signal и не ждёт дольше timeoutMs, даже если модель игнорирует signal. */
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({
  classify = mockClassify,
  timeoutMs = MODEL_TIMEOUT_MS,
  html = "",
  logger = console,
} = {}) {
  async function handleTriage(request, response) {
    const text = parseInput(await readBody(request));
    if (text === null) return json(response, 400, INVALID_INPUT);

    let raw;
    try {
      raw = await callModel(classify, text, timeoutMs);
    } catch (error) {
      logger.warn(`[triage] manual_review: ${error.message}`);
      return json(response, 200, MANUAL_REVIEW);
    }

    const result = parseModelOutput(raw);
    if (result === null) {
      logger.warn("[triage] manual_review: model output rejected by validation");
      return json(response, 200, MANUAL_REVIEW);
    }
    return json(response, 200, { status: "ready", ...result });
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch (error) {
      logger.error("[triage] server_error", error);
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = await readFile(new URL("./index.html", import.meta.url));
  const port = Number(process.env.PORT || 3000);
  createApp({ html }).listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
