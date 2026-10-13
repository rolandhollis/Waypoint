import { config } from "../config.js";

export type JiraIssueRef = {
  id: string;
  key: string;
  self?: string;
};

export type JiraIssueView = {
  id: string;
  key: string;
  summary: string;
  statusName: string;
  statusCategoryKey: string | null;
};

export class JiraClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "JiraClientError";
  }
}

export function jiraConfigured(): boolean {
  const j = config.jira;
  return Boolean(j.syncEnabled && j.baseUrl && j.email && j.apiToken && j.projectKey);
}

function authHeader(): string {
  const raw = `${config.jira.email}:${config.jira.apiToken}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function jiraFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!jiraConfigured()) {
    throw new JiraClientError("Jira sync is not configured");
  }
  const url = `${config.jira.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new JiraClientError(
      `Jira API ${res.status} ${path}: ${text.slice(0, 400)}`,
      res.status,
      text,
    );
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** ADF doc with a single paragraph — Jira Cloud description field. */
export function plainTextToAdf(text: string): Record<string, unknown> {
  const body = text.trim() || " ";
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: body.slice(0, 32000) }],
      },
    ],
  };
}

export type CreateEpicInput = {
  summary: string;
  description: string;
  labels?: string[];
  /** SHOP Brand option value (e.g. RMN). Written when brandFieldId is configured. */
  brandCode?: string | null;
  /** SHOP Pod option values (e.g. Loyalty, Personalization). Multicheckboxes. */
  podNames?: string[] | null;
};

function applyOptionField(
  fields: Record<string, unknown>,
  fieldId: string,
  value: string | null | undefined,
): void {
  const code = value?.trim();
  if (!fieldId || !code) return;
  fields[fieldId] = [{ value: code }];
}

function applyMultiOptionField(
  fields: Record<string, unknown>,
  fieldId: string,
  values: string[] | null | undefined,
): void {
  if (!fieldId || values === undefined || values === null) return;
  const cleaned = values.map((v) => v.trim()).filter(Boolean);
  fields[fieldId] = cleaned.map((value) => ({ value }));
}

export async function createEpic(input: CreateEpicInput): Promise<JiraIssueRef> {
  const fields: Record<string, unknown> = {
    project: { key: config.jira.projectKey },
    issuetype: { name: config.jira.issueType },
    summary: input.summary.slice(0, 255),
    description: plainTextToAdf(input.description),
  };
  if (input.labels?.length) {
    fields.labels = input.labels
      .map((l) => l.replace(/\s+/g, "-").slice(0, 255))
      .filter(Boolean)
      .slice(0, 20);
  }
  applyOptionField(fields, config.jira.brandFieldId, input.brandCode);
  applyMultiOptionField(fields, config.jira.podFieldId, input.podNames);
  return jiraFetch<JiraIssueRef>("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

export async function updateEpic(
  issueKeyOrId: string,
  input: {
    summary?: string;
    description?: string;
    labels?: string[];
    brandCode?: string | null;
    podNames?: string[] | null;
  },
): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary.slice(0, 255);
  if (input.description !== undefined) {
    fields.description = plainTextToAdf(input.description);
  }
  if (input.labels !== undefined) {
    fields.labels = input.labels
      .map((l) => l.replace(/\s+/g, "-").slice(0, 255))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (input.brandCode !== undefined) {
    applyOptionField(fields, config.jira.brandFieldId, input.brandCode);
  }
  if (input.podNames !== undefined) {
    applyMultiOptionField(fields, config.jira.podFieldId, input.podNames);
  }
  if (Object.keys(fields).length === 0) return;
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

type TransitionsResponse = {
  transitions: Array<{ id: string; name: string; to: { name: string } }>;
};

export async function transitionEpic(
  issueKeyOrId: string,
  targetStatusName: string,
): Promise<boolean> {
  const want = targetStatusName.trim().toLowerCase();
  const data = await jiraFetch<TransitionsResponse>(
    `/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}/transitions`,
  );
  const match = (data.transitions ?? []).find(
    (t) =>
      t.name.trim().toLowerCase() === want ||
      t.to?.name?.trim().toLowerCase() === want,
  );
  if (!match) return false;
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  return true;
}

type IssueResponse = {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
  };
};

export async function getIssue(issueKeyOrId: string): Promise<JiraIssueView> {
  const data = await jiraFetch<IssueResponse>(
    `/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}?fields=summary,status`,
  );
  return {
    id: data.id,
    key: data.key,
    summary: data.fields?.summary ?? "",
    statusName: data.fields?.status?.name ?? "",
    statusCategoryKey: data.fields?.status?.statusCategory?.key ?? null,
  };
}

export function jiraBrowseUrl(issueKey: string): string {
  return `${config.jira.baseUrl}/browse/${encodeURIComponent(issueKey)}`;
}

/** Extract KEY-123 from a browse URL or bare key. */
export function parseJiraKeyFromText(raw: string): string | null {
  const trimmed = raw.trim();
  const bare = trimmed.match(/^([A-Z][A-Z0-9]+-\d+)$/i);
  if (bare) return bare[1]!.toUpperCase();
  const fromUrl = trimmed.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9]+-\d+)/i);
  if (fromUrl) return fromUrl[1]!.toUpperCase();
  return null;
}
