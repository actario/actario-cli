import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AnalysisSubmitResponse, BundleMeta, CaptureReport, ManifestFile, MeResponse, SourceCreate, SourceDto, UploadStatusResponse, UploadsInitResponse,
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

async function request<T>(
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
