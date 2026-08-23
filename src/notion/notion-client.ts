import type { NotionBlock } from "./eco-plan-blocks.js";

/**
 * Minimal Notion REST client — just enough to create a page with content
 * under a parent page. No SDK dependency: two JSON endpoints over fetch,
 * matching this project's existing preference for plain `pg`/`fetch` over
 * heavier client libraries.
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export type CreatedNotionPage = {
  id: string;
  url: string;
};

function requireApiKey(): string {
  const key = process.env.NOTION_API_KEY;
  if (!key) {
    throw new Error(
      "NOTION_API_KEY is not set. Create an internal integration at notion.so/my-integrations, " +
        "share the target parent page with it, and set NOTION_API_KEY in .env."
    );
  }
  return key;
}

async function notionFetch(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${init.method ?? "GET"} ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Creates a page with the given title/icon/content directly under a parent
 * page. Notion allows up to two levels of nested block children in a single
 * create call (page -> table -> table_row), which is exactly this shape, so
 * everything is sent in one request — no follow-up "append children" calls.
 */
export async function createNotionPage(opts: {
  parentPageId: string;
  title: string;
  icon?: string;
  blocks: NotionBlock[];
}): Promise<CreatedNotionPage> {
  const body = {
    parent: { page_id: opts.parentPageId },
    properties: {
      title: { title: [{ type: "text", text: { content: opts.title } }] },
    },
    ...(opts.icon ? { icon: { type: "emoji", emoji: opts.icon } } : {}),
    children: opts.blocks,
  };

  const result = (await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify(body),
  })) as { id: string; url: string };

  return { id: result.id, url: result.url };
}
