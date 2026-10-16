export const runtime = "edge";

const MAX_TEXT_LENGTH = 1800;
const LANGUAGE_CODES = new Set([
  "en",
  "zh-CN",
  "es",
  "fr",
  "de",
  "ja",
  "ko",
  "pt",
  "it",
  "ru",
  "ar",
  "hi",
  "id",
  "vi",
  "th",
]);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      text?: unknown;
      source?: unknown;
      target?: unknown;
    };
    if (typeof body.text !== "string") {
      return Response.json({ error: "invalid_text" }, { status: 400 });
    }

    const text = body.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
    if (!text) return Response.json({ translation: "" });
    const source = typeof body.source === "string" ? body.source : "en";
    const target = typeof body.target === "string" ? body.target : "zh-CN";
    if (!LANGUAGE_CODES.has(source) || !LANGUAGE_CODES.has(target)) {
      return Response.json({ error: "invalid_language" }, { status: 400 });
    }
    if (source === target) return Response.json({ translation: text });

    const endpoint = new URL("https://translate.googleapis.com/translate_a/single");
    endpoint.searchParams.set("client", "gtx");
    endpoint.searchParams.set("sl", source);
    endpoint.searchParams.set("tl", target);
    endpoint.searchParams.set("dt", "t");
    endpoint.searchParams.set("q", text);

    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(9_000),
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 Classroom Interpreter",
      },
    });

    if (!response.ok) {
      return Response.json({ error: "upstream_error" }, { status: 502 });
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
      return Response.json({ error: "invalid_response" }, { status: 502 });
    }

    const translation = payload[0]
      .map((part: unknown) =>
        Array.isArray(part) && typeof part[0] === "string" ? part[0] : "",
      )
      .join("")
      .trim();

    return Response.json(
      { translation },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    return Response.json({ error: "translation_failed" }, { status: 500 });
  }
}
