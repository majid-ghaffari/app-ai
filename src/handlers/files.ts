/**
 * /files endpoints — provider-neutral compatibility surface over adapter files.
 *
 *   POST   /files       → upload   (handleFileUpload)
 *   DELETE /files/{id}  → delete   (handleDeleteFile)
 *
 * Upload requires repeated registered `prompt` fields, resolves every unique
 * prompt-group route before provider I/O, uploads those routes in parallel,
 * and returns only authenticated encrypted opaque public references: the first
 * declared prompt's reference plus a `references` map naming every declared
 * prompt, whatever the number of routes those prompts resolve to. The upload is
 * one caller action across every route: a route failure answers with the
 * failure and no reference, releasing the objects its siblings created.
 *
 * Neither verb assumes a provider, and neither can reach an object this caller
 * did not create: delete reads the route and owning tenant out of the sealed
 * reference it is given, and there is no verb that enumerates a provider
 * account, because the account holds every tenant's uploads. Failures use the
 * Brain-shaped envelope; an Anthropic 500 upload keeps the Files-API-beta-access
 * hint.
 */

import { dedupUpload } from '../lib/file-dedup';
import { jsonResponse, errorResponse, errorResponseFrom, type CorsHeaders } from '../lib/responses';
import { createLoggingRuntime, type Logger, type LoggingRuntime } from '../lib/logger';
import type { Env } from '../config';
import { getGroupModelRoute, isPromptName, type PromptName } from '../prompt-registry';
import { createInferenceFileService, type InferenceFileService } from '../inference/factory';
import { InferenceFailure } from '../inference/adapter';
import {
  fileReferenceRouteGroup,
  mintOpaqueFileReference,
  fileTenantScope,
  openOwnedFileReference,
  preflightFileReferenceSealing,
  resolvePromptFileRoute,
  type ResolvedFileRoute,
} from '../inference/file-references';
import type { OpaqueFileReference, ProviderFileReference } from '../lib/inference-types';

/** POST /files — upload directly to every unique route required by declared prompts. */
export async function handleFileUpload(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime = createLoggingRuntime(env),
  options: { readonly tenantScope?: string } = {},
): Promise<Response> {
  const log = logging.logger('Files');
  try {
    log.info('File upload request received');

    const formData = await request.formData();
    const fileParts = formData.getAll('file');
    if (fileParts.length === 0) {
      return errorResponse('No file provided', corsHeaders, 400, 'ArgumentException');
    }
    const candidate: unknown = fileParts[0];
    if (
      fileParts.length !== 1 ||
      !candidate ||
      typeof candidate !== 'object' ||
      !('arrayBuffer' in candidate) ||
      typeof candidate.arrayBuffer !== 'function'
    ) {
      return errorResponse(
        'Exactly one file part is required',
        corsHeaders,
        400,
        'ArgumentException',
      );
    }
    const file = candidate as File;

    const prompts = parseDestinationPrompts(formData, corsHeaders);
    if (prompts instanceof Response) return prompts;

    await preflightFileReferenceSealing(env);
    const tenantScope =
      options.tenantScope ??
      (await fileTenantScope(request.headers.get('X-Personalizer-Context-ID'), env));
    if (!tenantScope) throw new Error('Prompt-aware file upload requires a validated tenant');

    log.info(`Uploading file (${file.size} bytes, ${file.type})`);

    const files = createInferenceFileService(env);
    const promptRoutes = await Promise.all(
      prompts.map((prompt) => resolvePromptFileRoute(prompt, env, files, tenantScope)),
    );
    const uniqueRoutes = uniqueFileRoutes(promptRoutes);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const settled = await Promise.allSettled(
      uniqueRoutes.map(async (route): Promise<RouteUpload> => {
        const result = await dedupUpload(
          {
            content: bytes,
            mimeType: file.type || 'application/octet-stream',
            filename: file.name || 'upload',
          },
          route,
          env,
          request.signal,
          log.child({ promptGroup: route.group, provider: route.profile.provider }),
        );
        return { route, reference: result.reference, deduped: result.deduped };
      }),
    );
    const succeeded = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const rejection = settled.find((outcome) => outcome.status === 'rejected');
    if (rejection) {
      await releaseOrphanedUploads(succeeded, files, log);
      const reason: unknown = rejection.reason;
      throw reason;
    }
    const uploads = await Promise.all(
      succeeded.map(async (upload) => ({
        route: upload.route,
        publicReference: await mintOpaqueFileReference(upload.reference, env),
        deduped: upload.deduped,
      })),
    );

    const response = promptAwareResponse(prompts, promptRoutes, uploads);
    log.info('File uploaded successfully', {
      promptCount: prompts.length,
      routeCount: uniqueRoutes.length,
      dedupHits: uploads.filter((upload) => upload.deduped).length,
    });
    return jsonResponse(response, corsHeaders);
  } catch (error) {
    log.error('File upload failed', error, { inference: fileOperationFailureTrace(error) });
    return errorResponseFrom(error, corsHeaders, 'Internal proxy server error during file upload');
  }
}

/**
 * DELETE /files/{id} — delete the object behind one opaque reference.
 *
 * The reference IS the route: provider, file policy, owning tenant, and upstream
 * object id were sealed into it at upload, so the delete resolves the real
 * provider from the token instead of assuming whichever one came first. A
 * reference minted for another tenant is refused, and a route whose configured
 * provider has since moved away from the sealed one fails rather than deleting
 * an unrelated object on a different account.
 */
export async function handleDeleteFile(
  fileId: string,
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime = createLoggingRuntime(env),
): Promise<Response> {
  const log = logging.logger('Files');
  try {
    log.info('Delete file request received');

    await preflightFileReferenceSealing(env);
    const tenantScope = await fileTenantScope(
      request.headers.get('X-Personalizer-Context-ID'),
      env,
    );
    if (!tenantScope) throw new Error('File deletion requires a validated tenant');
    const reference = await openOwnedFileReference(fileId, env, tenantScope);
    const { profile, policy } = getGroupModelRoute(fileReferenceRouteGroup(reference), env);
    const files = createInferenceFileService(env);
    if (
      profile.provider !== reference.provider ||
      policy.name !== reference.filePolicy ||
      (await files.scope(profile, policy)) !== reference.accountScope
    ) {
      return errorResponse(
        'File reference does not belong to the configured provider route',
        corsHeaders,
        409,
        'ArgumentException',
      );
    }
    await files.delete(profile, reference.upstreamFileId, request.signal);

    return jsonResponse({ success: true, message: 'File deleted successfully' }, corsHeaders);
  } catch (error) {
    log.error('Delete file failed', error, { inference: fileOperationFailureTrace(error) });
    return errorResponseFrom(
      error,
      corsHeaders,
      'Internal proxy server error during file deletion',
    );
  }
}

/** One route's completed upload, before any public reference is minted for it. */
interface RouteUpload {
  readonly route: ResolvedFileRoute;
  readonly reference: ProviderFileReference;
  readonly deduped: boolean;
}

/**
 * Delete the provider objects this upload created once another route failed.
 *
 * A multi-route upload is one caller action: when any route fails the caller is
 * answered with an error and no reference at all, so an object a sibling route
 * created is unreachable and would occupy the provider account for good. A
 * deduped result reused an object an earlier upload created and still owns, so
 * it is left in place. Release is best effort — the caller hears about the
 * upload failure, which is the one that lost them the request.
 */
async function releaseOrphanedUploads(
  uploads: readonly RouteUpload[],
  files: InferenceFileService,
  log: Logger,
): Promise<void> {
  await Promise.all(
    uploads
      .filter((upload) => !upload.deduped)
      .map(async (upload) => {
        try {
          await files.delete(upload.route.profile, upload.reference.upstreamFileId);
        } catch (error) {
          log.warn('Failed to release an orphaned upload after a sibling route failed', {
            promptGroup: upload.route.group,
            provider: upload.route.profile.provider,
            inference: fileOperationFailureTrace(error),
          });
        }
      }),
  );
}

function parseDestinationPrompts(
  formData: FormData,
  corsHeaders: CorsHeaders,
): readonly [PromptName, ...PromptName[]] | Response {
  const values = formData.getAll('prompt');
  if (values.length === 0) {
    return errorResponse(
      'At least one destination prompt is required',
      corsHeaders,
      400,
      'ArgumentException',
    );
  }
  const prompts: PromptName[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !isPromptName(value)) {
      return errorResponse('Unknown destination prompt', corsHeaders, 400, 'ArgumentException');
    }
    if (!prompts.includes(value)) prompts.push(value);
  }
  return prompts as [PromptName, ...PromptName[]];
}

function uniqueFileRoutes(routes: readonly ResolvedFileRoute[]): ResolvedFileRoute[] {
  const unique = new Map<string, ResolvedFileRoute>();
  for (const route of routes) {
    const key = JSON.stringify([
      route.profile.provider,
      route.profile.apiFamily,
      route.accountScope,
      route.tenantScope,
      route.policy.name,
      route.compatibleGroups,
    ]);
    if (!unique.has(key)) unique.set(key, route);
  }
  return [...unique.values()];
}

/**
 * Compose the one upload response shape: the first declared prompt's reference,
 * plus a `references` map naming EVERY declared prompt.
 *
 * Destinations that share a provider file route share the reference minted for
 * it, so an upload resolving to a single route names every declared prompt
 * against that one value rather than omitting the map. The reference is valid
 * for each of them because it seals the route group's whole compatible set, and
 * every prompt sharing the route is a member of it.
 */
function promptAwareResponse(
  prompts: readonly [PromptName, ...PromptName[]],
  promptRoutes: readonly ResolvedFileRoute[],
  uploads: readonly {
    route: ResolvedFileRoute;
    publicReference: OpaqueFileReference;
    deduped: boolean;
  }[],
): OpaqueFileReference & {
  readonly references: Readonly<Partial<Record<PromptName, OpaqueFileReference>>>;
} {
  const referenceByGroup = new Map(
    uploads.map((upload) => [upload.route.group, upload.publicReference] as const),
  );
  const firstRoute = promptRoutes[0];
  if (!firstRoute) throw new Error('First destination route was not resolved');
  const first = referenceByGroup.get(firstRoute.group);
  if (!first) throw new Error('First destination route was not uploaded');
  const references = Object.fromEntries(
    prompts.map((prompt, index) => {
      const route = promptRoutes[index];
      if (!route) throw new Error(`Destination route was not resolved for ${prompt}`);
      const reference = referenceByGroup.get(route.group);
      if (!reference) throw new Error(`Destination route was not uploaded for ${prompt}`);
      return [prompt, reference];
    }),
  ) as Readonly<Partial<Record<PromptName, OpaqueFileReference>>>;
  return { ...first, references };
}

/** Summarize the failure; the raw exception is preserved separately through central redaction. */
function fileOperationFailureTrace(error: unknown): Record<string, unknown> {
  if (error instanceof InferenceFailure) {
    return {
      backend: error.inferenceError.backend,
      status: error.inferenceError.status,
      code: error.inferenceError.code,
      failureClass: error.inferenceError.failureClass,
      retryable: error.inferenceError.retryable,
    };
  }
  return { type: error instanceof Error ? error.name : 'unknown' };
}
