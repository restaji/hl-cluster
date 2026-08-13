export const config = { runtime: "edge" };

const HL = "https://api.hyperliquid.xyz/info";

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return new Response("POST only", { status: 405 });
  }
  const r = await fetch(HL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: {
      "Content-Type": r.headers.get("content-type") ?? "application/json",
    },
  });
}
