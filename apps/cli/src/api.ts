import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AnalysisSubmitResponse, BundleMeta, CaptureReport, ManifestFile, MeResponse, MemoryPackResponse, MemoryPackSave, MemoryPackSaved,
  MemoryPacksResponse, MemorySourcesResponse, RunsResponse, ShareCreate, ShareCreated, ShareListItem, ShareMemoryContent,
  ShareOpened, ShareRunContent, SourceCreate, SourceDto, TranscriptInclude, TranscriptResponse,
  UploadStatusResponse, UploadsInitResponse,
} from '@distill/shared';
import { DistillError, logger, type ErrorCode } from '@distill/shared';

export interface ApiOptions {
  baseUrl: string;
  token: string;
}

/**
 * A 4xx that does not carry the app's error envelope still has a status, and
 * the status is the most actionable thing on hand.
 *
 * Defaulting those to `internal` reported the user's own wrong token as our
 * bug. That is the first wall a new person hits -- a token mistyped, expired,
 * or minted in another workspace -- and `internal: 403 Forbidden` tells them
 * neither what is wrong nor what to do. Nothing upstream of the route
 * handler (a platform 403, an edge auth check) speaks our envelope, so the
 * envelope cannot be the only source of a code.
 */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

const fallbackMessage = (status: number, statusText: string, baseUrl: string): string => {
  if (status === 401 || status === 403) {
    return `${baseUrl} rejected this token (${status}). It may be mistyped, revoked, or minted for a different workspace. `
      + 'Create a new one under Settings -> Access tokens, then link again.';
  }
  if (status === 404) {
    return `${baseUrl} has no Actario API at this path (404). Check the API URL -- it should be the workspace's base URL, nothing after the host.`;
  }
  if (status === 429) return `${baseUrl} is rate limiting this token. Wait a moment and retry.`;
  return `${status} ${statusText}`;
};

export async function request<T>(
  opts: ApiOptions,
  path: string,
  init: RequestInit & { attempts?: number } = {},
): Promise<T> {
  const attempts = init.attempts ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(new URL(path, opts.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    }).catch((e: Error) => e);

    if (res instanceof Error) {
      lastError = res;
    } else if (res.ok) {
      // A URL that answers 200 with a web page is the other half of "the API
      // URL is wrong", and a raw SyntaxError names neither the URL nor the
      // cause.
      try {
        return (await res.json()) as T;
      } catch {
        throw new DistillError('invalid_request',
          `${opts.baseUrl} answered ${path} with something that is not JSON. Check the API URL points at an Actario workspace.`,
          undefined, 502);
      }
    } else if (res.status === 409 || res.status < 500) {
      // 4xx is a decision, not a hiccup: surface the body, do not retry.
      const body = await res.json().catch(() => ({}));
      const err = (body as { error?: { code?: string; message?: string; details?: unknown } }).error;
      throw new DistillError(
        (err?.code as ErrorCode | undefined) ?? CODE_BY_STATUS[res.status] ?? 'internal',
        err?.message ?? fallbackMessage(res.status, res.statusText, opts.baseUrl),
        err?.details,
        res.status,
      );
    } else {
      lastError = new Error(`${res.status} ${res.statusText}`);
    }

    if (attempt < attempts) {
      const backoff = 400 * 2 ** (attempt - 1);
      logger.warn('request failed, retrying', { path, attempt, backoff, error: lastError?.message });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new DistillError('internal', `Request to ${path} failed: ${lastError?.message}`, undefined, 502);
}

export interface PushResult {
  uploadId: string;
  resumed: boolean;
  uploaded: string[];
}

/**
 * The three-step upload protocol (7.2).
 *
 *   init      -> declares the manifest, gets one signed URL per file
 *   PUT       -> straight to storage, bypassing the app server's body limits
 *   complete  -> the server compares declared hashes against stored objects
 *
 * Storage webhooks are deliberately not involved: a webhook fires per object
 * and cannot know the batch is finished, which leaves either a counting
 * heuristic or uploads stuck forever. The CLI saying "done" is both simpler
 * and verifiable.
 */
export async function pushBundle(
  opts: ApiOptions,
  input: {
    sourceId: string;
    bundleDir: string;
    bundleMeta: BundleMeta;
    captureReport: CaptureReport;
    files: ManifestFile[];
    concurrency?: number;
  },
): Promise<PushResult> {
  const init = await request<UploadsInitResponse>(opts, '/api/v1/uploads/init', {
    method: 'POST',
    body: JSON.stringify({
      source_id: input.sourceId,
      bundle_meta: input.bundleMeta,
      capture_report: input.captureReport,
      files: input.files,
    }),
  });

  const urls = new Map(init.urls.map((u) => [u.name, u.signed_url]));
  const queue = [...input.files];
  const uploaded: string[] = [];
  const concurrency = input.concurrency ?? 3;

  // Resume is per file (7.2): a dropped connection re-sends one part, not the
  // whole bundle.
  const worker = async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const url = urls.get(file.name);
      if (!url) continue; // already stored from an earlier attempt
      await putFile(url, join(input.bundleDir, file.name));
      uploaded.push(file.name);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  await request(opts, `/api/v1/uploads/${init.upload_id}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      files: input.files.map((f) => ({ name: f.name, sha256: f.sha256 })),
    }),
  });

  return { uploadId: init.upload_id, resumed: init.resumed, uploaded };
}

async function putFile(signedUrl: string, path: string, attempts = 4): Promise<void> {
  const size = (await stat(path)).size;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = size > 8 * 1024 * 1024
        // Stream the big parts; Node needs duplex: 'half' for a stream body.
        ? (createReadStream(path) as unknown as ReadableStream)
        : await readFile(path);
      const res = await fetch(signedUrl, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
        ...(size > 8 * 1024 * 1024 ? { duplex: 'half' } : {}),
      } as RequestInit);
      if (res.ok) return;
      lastError = new Error(`${res.status} ${res.statusText}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastError = e as Error;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw new DistillError('internal', `Upload of ${path} failed: ${lastError?.message}`, undefined, 502);
}

export const getUpload = (opts: ApiOptions, id: string): Promise<UploadStatusResponse> =>
  request<UploadStatusResponse>(opts, `/api/v1/uploads/${id}`, { method: 'GET' });

/**
 * POST /uploads/{id}/analysis -- hand the server a DAF (arch v1.3 18.8).
 * The body goes as written: the CLI validated it locally, the server
 * validates it again and never trusts either of us (C8).
 */
export const submitAnalysis = (opts: ApiOptions, uploadId: string, dafJson: string): Promise<AnalysisSubmitResponse> =>
  request<AnalysisSubmitResponse>(opts, `/api/v1/uploads/${uploadId}/analysis`, { method: 'POST', body: dafJson, attempts: 1 });

/**
 * GET /uploads/{id}/export -- the whole archive as bytes (unit 0001). Used by
 * `actario analyze --bundle` when the bundle is not in the local store any
 * more; only the bundle/ members are kept from it.
 */
export async function downloadExport(opts: ApiOptions, uploadId: string): Promise<Buffer> {
  const res = await fetch(new URL(`/api/v1/uploads/${uploadId}/export`, opts.baseUrl), {
    headers: { authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new DistillError((err?.code as never) ?? 'internal', err?.message ?? `${res.status} ${res.statusText}`, err?.details, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** What this token is allowed to do. One attempt: a 401 here is an answer, not a hiccup. */
export const whoami = (opts: ApiOptions): Promise<MeResponse> =>
  request<MeResponse>(opts, '/api/v1/me', { method: 'GET', attempts: 1 });

/** Sources this token's user registered. */
export const listSources = (opts: ApiOptions): Promise<{ sources: SourceDto[] }> =>
  request<{ sources: SourceDto[] }>(opts, '/api/v1/sources', { method: 'GET', attempts: 1 });

/** Register this machine as a source. */
export const createSource = (opts: ApiOptions, body: SourceCreate): Promise<SourceDto> =>
  request<SourceDto>(opts, '/api/v1/sources', { method: 'POST', body: JSON.stringify(body), attempts: 1 });

/** One-way: general -> medical only, like the server. */
export const patchSource = (opts: ApiOptions, id: string, body: { profile?: 'medical'; label?: string | null }): Promise<SourceDto> =>
  request<SourceDto>(opts, `/api/v1/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body), attempts: 1 });

// ── restore and memory (arch v2.1 ch. 22, CLI 0.1.4) ──

/** `?a=1&b=x`, skipping undefined, null and empty values. */
const qs = (params: Record<string, string | number | undefined | null>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

/** GET /runs -- runs this person can bring back, newest first. */
export const findRunsApi = (
  opts: ApiOptions, q: { q?: string; agent?: string; since?: string; until?: string; limit?: number; cursor?: string },
): Promise<RunsResponse> =>
  request<RunsResponse>(opts, `/api/v1/runs${qs(q)}`, { method: 'GET' });

/** One hit of GET /search (improvement plan C1): where it is, and a short window of text around the match. */
export interface SearchHit {
  kind: 'line' | 'run' | 'page' | 'segment' | 'turn';
  run_id?: string; agent_id?: string | null; title?: string | null; heading?: string | null;
  idx?: number; role?: string; start_turn_idx?: number | null; end_turn_idx?: number | null;
  section?: number; snippet?: string; last_active?: string; id?: string; name?: string;
}
export interface SearchResponse {
  q: string;
  /** v2 (arch 28.7): files the agent wrote, tags, Notes, memories, and the filters the server read from the query. */
  outputs?: { run_id: string; run_title: string | null; agent_id: string | null; last_active: string; path: string; turn_idx: number; snippet: string }[];
  tags?: { run_id: string; run_title: string | null; agent_id: string | null; last_active: string; tag: string }[];
  notes?: { id: string; title: string; agent_id: string | null; updated_at: string; snippet: string }[];
  memory?: { id: string; title: string; updated_at: string; snippet: string }[];
  filters?: { words: string; tags: string[]; line: string | null; lineId: string | null; kinds: string[] | null; types: string[]; after: string | null; before: string | null; unknown: string[] };
  lines: { id: string; name: string }[];
  runs: { id: string; title: string | null; agent_id: string | null; last_active: string }[];
  pages: { run_id: string; page_title: string; run_title: string | null; agent_id: string | null; last_active: string; section: number; heading: string | null; start_turn_idx: number | null; end_turn_idx: number | null; snippet: string }[];
  segments: { run_id: string; run_title: string | null; agent_id: string | null; last_active: string; start_turn_idx: number; end_turn_idx: number; topic: string | null; snippet: string }[];
  turns: { run_id: string; run_title: string | null; agent_id: string | null; idx: number; role: string; timestamp: string | null; snippet: string }[];
  more: Record<string, boolean>;
}

/** GET /search -- note pages, summaries, conversation text, files the agent wrote, tags, Notes, memories (never tool output). */
export const searchApi = (
  opts: ApiOptions, q: { q: string; kinds?: string[]; agent?: string; tags?: string[]; limit?: number },
): Promise<SearchResponse> =>
  request<SearchResponse>(opts, `/api/v1/search${qs({ q: q.q, kinds: q.kinds?.join(','), agent: q.agent, tags: q.tags?.join(','), limit: q.limit })}`, { method: 'GET' });

/** One candidate line from POST /lines/suggest (arch 28.4). */
export interface LineSuggestion {
  agent_id: string; name: string; kind: 'topic' | 'category'; category_key: string | null;
  score: number; reasons: { tag: string; w: number }[]; top_tags: string[];
}
export interface LineSuggestResponse {
  lines: LineSuggestion[];
  /** What the server would do with these tags if no agent chose (the same rule fn:analyze applies). */
  would: { action: 'existing' | 'new' | 'category' | 'unbound'; agent_id: string | null; name: string | null; needs_review: boolean };
  categories_enabled: boolean;
}

/** POST /lines/suggest -- rank this person's lines against a run's tags, so the agent can pick one. */
export const suggestLinesApi = (
  opts: ApiOptions, body: { tags: string[]; facets?: Record<string, unknown>; title?: string | null; limit?: number },
): Promise<LineSuggestResponse> =>
  request<LineSuggestResponse>(opts, '/api/v1/lines/suggest', { method: 'POST', body: JSON.stringify(body) });

/** GET /runs/{id or run_hash}/transcript -- one page of masked turns. */
export const getTranscript = (
  opts: ApiOptions, ref: string, q: { from?: number; limit?: number; include?: TranscriptInclude[] } = {},
): Promise<TranscriptResponse> =>
  request<TranscriptResponse>(
    opts,
    `/api/v1/runs/${encodeURIComponent(ref)}/transcript${qs({ from: q.from, limit: q.limit, include: q.include?.join(',') })}`,
    { method: 'GET' },
  );

/** GET /memory-sources -- the scope resolved to runs, with segments and note pages (no turns). */
export const getMemorySources = (
  opts: ApiOptions, q: { runs?: string[]; agent?: string; since?: string; until?: string; limit?: number },
): Promise<MemorySourcesResponse> =>
  request<MemorySourcesResponse>(
    opts,
    `/api/v1/memory-sources${qs({ runs: q.runs?.join(','), agent: q.agent, since: q.since, until: q.until, limit: q.limit })}`,
    { method: 'GET' },
  );

/** POST /memory-packs -- one attempt: a 409 memory_conflict is an answer, not a hiccup. */
export const saveMemoryPackApi = (opts: ApiOptions, body: MemoryPackSave): Promise<MemoryPackSaved> =>
  request<MemoryPackSaved>(opts, '/api/v1/memory-packs', { method: 'POST', body: JSON.stringify(body), attempts: 1 });

export const listMemoryPacksApi = (opts: ApiOptions): Promise<MemoryPacksResponse> =>
  request<MemoryPacksResponse>(opts, '/api/v1/memory-packs', { method: 'GET' });

export const getMemoryPackApi = (opts: ApiOptions, id: string, version?: number): Promise<MemoryPackResponse> =>
  request<MemoryPackResponse>(opts, `/api/v1/memory-packs/${encodeURIComponent(id)}${qs({ version })}`, { method: 'GET' });

// ── shares (arch v2.1 22.4-22.5, CLI 0.1.5) ──

/** POST /shares -- one attempt: a share is not something to create twice on a retry. */
export const createShareApi = (opts: ApiOptions, body: ShareCreate): Promise<ShareCreated> =>
  request<ShareCreated>(opts, '/api/v1/shares', { method: 'POST', body: JSON.stringify(body), attempts: 1 });

export const sealShareApi = (opts: ApiOptions, shareId: string, sha256: string): Promise<{ share_id: string; sealed_path: string }> =>
  request(opts, `/api/v1/shares/${shareId}/sealed`, { method: 'POST', body: JSON.stringify({ sha256 }), attempts: 1 });

export const listSharesApi = (opts: ApiOptions, run?: string): Promise<{ shares: ShareListItem[] }> =>
  request(opts, `/api/v1/shares${qs({ run })}`, { method: 'GET' });

export const revokeShareApi = (opts: ApiOptions, shareId: string): Promise<{ share_id: string; revoked: boolean; sealed_file_deleted: boolean | null }> =>
  request(opts, `/api/v1/shares/${shareId}`, { method: 'DELETE', attempts: 1 });

/** GET /shares/{token} -- one attempt: every open counts against the share's limit. */
export const openShareApi = (opts: ApiOptions, token: string, action: 'open' | 'restore'): Promise<ShareOpened> =>
  request<ShareOpened>(opts, `/api/v1/shares/${token}${qs({ action })}`, { method: 'GET', attempts: 1 });

export const shareContentApi = <T extends ShareRunContent | ShareMemoryContent>(opts: ApiOptions, token: string, from = 0, limit = 500): Promise<T> =>
  request<T>(opts, `/api/v1/shares/${token}/content${qs({ from, limit })}`, { method: 'GET' });

export const forkShareApi = (opts: ApiOptions, token: string): Promise<{ run_id: string; created: boolean }> =>
  request(opts, `/api/v1/shares/${token}/fork`, { method: 'POST', body: '{}', attempts: 1 });

/** PUT the sealed file to its signed storage URL. */
export async function putSealed(signedUrl: string, bytes: Buffer): Promise<void> {
  const res = await fetch(signedUrl, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'application/octet-stream' } });
  if (!res.ok) throw new DistillError('internal', `Uploading the sealed file failed: ${res.status} ${res.statusText}`, undefined, 502);
}

export async function getSealed(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new DistillError('not_found', `The sealed file could not be downloaded (${res.status}).`, undefined, 404);
  return Buffer.from(await res.arrayBuffer());
}

// ── the account binding (arch v2.1 ch. 22 addendum, CLI 0.1.5) ──

/**
 * POST /local-pass -- is this pass, issued by the Actario connector of the
 * Claude account in use, good for this machine's person and workspace? One
 * attempt: an answer either way is final. The same question for a local key
 * (arch v3.1 23.12); `bind` is the save, which binds the key to this
 * machine's token.
 */
export const checkPassApi = (opts: ApiOptions, pass: string, bind = false): Promise<{ client_name: string; expires_at: string; workspace_id: string; scopes: string[] }> =>
  request(opts, '/api/v1/local-pass', { method: 'POST', body: JSON.stringify(bind ? { pass, bind: true } : { pass }), attempts: 1 });
