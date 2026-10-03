/** A request's JSON body, read and parsed once: its value, or the error reading or parsing it raised. */
export type JsonBody = { readonly value: unknown } | { readonly failure: unknown };

/** Read and parse a request's JSON body once, keeping a failure for the handler to answer. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  try {
    return { value: (await request.json()) as unknown };
  } catch (failure) {
    return { failure };
  }
}

/** The value of a read JSON body, or the failure reading it raised, thrown. */
export function jsonBodyValue(body: JsonBody): unknown {
  if ('failure' in body) throw body.failure;
  return body.value;
}

/**
 * Read a request's body once, stopping as soon as it passes `maxBytes`: the bytes, or `null` for a
 * body its `Content-Length` or its stream shows is larger.
 */
export async function readBodyBytesWithin(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declaredBytes = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
