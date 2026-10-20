// Receives pipeline lists from nxport (POST /submit, text/plain) and stores each as a file on the repository's
// `incoming` branch; the merge workflow validates and merges them. Nothing about the sender is stored: the client
// address is used only for Cloudflare's in-memory rate limit.

const MAX_BYTES = 1_500_000;
const MAX_ENTRIES = 4000;
const HEADER = /^# nxport pipelines title ([0-9a-f]{16}) build ([0-9a-f]{1,64}|-)$/;
const NAME = "s_[0-9a-f]{16}";
const HEX = "[0-9a-f]{1,16}";
const LIST = (item) => `(?:\\.|${item}(?:,${item}){0,31})`;
const ENTRY = new RegExp(
  `^p1 ${NAME} (?:${NAME}|-) ${HEX} [01] [01] ${HEX} ${HEX} [0-9]{1,4} ` +
    `[0-9]{1,4}(?:,[0-9]{1,4}){7} ${HEX}(?:,${HEX}){7} ${LIST(`(?:${HEX}|-)`)} ${LIST(HEX)}$`,
);

function reply(status, text) {
  return new Response(text + "\n", { status, headers: { "content-type": "text/plain" } });
}

async function github(env, method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "nxport-pipelines",
    },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/submit") return reply(404, "not found");
    const { success } = await env.LIMIT.limit({ key: request.headers.get("cf-connecting-ip") || "" });
    if (!success) return reply(429, "too many submissions");
    const length = Number(request.headers.get("content-length") || 0);
    if (!length || length > MAX_BYTES) return reply(413, "too large");
    const text = await request.text();
    if (text.length > MAX_BYTES) return reply(413, "too large");

    const lines = text.split("\n").filter((l) => l.length);
    const head = HEADER.exec(lines[0] || "");
    if (!head) return reply(400, "no list header");
    const title = head[1];
    if (env.TITLES && !env.TITLES.split(",").includes(title)) return reply(400, "unknown game");
    const entries = [...new Set(lines.slice(1))];
    if (!entries.length || entries.length > MAX_ENTRIES) return reply(400, "bad entry count");
    if (!entries.every((l) => ENTRY.test(l))) return reply(400, "malformed entry");

    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`;
    const body = [lines[0], ...entries].join("\n") + "\n";
    const bytes = new TextEncoder().encode(body);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    try {
      await github(env, "PUT", `contents/submissions/${title}/${id}.txt`, {
        message: `Submission ${title}`,
        content: btoa(bin),
        branch: "incoming",
      });
    } catch (e) {
      return reply(502, "could not store the submission");
    }
    return reply(200, `received ${entries.length}`);
  },
};
