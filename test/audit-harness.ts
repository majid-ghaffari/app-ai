import { expect } from 'vitest';

import worker from '../src/index';
import { AuditSessionAuthority } from '../src/lib/audit-session-authority';
import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import type { Env } from '../src/config';
import { AUDIT_STATUS_CALLBACK_URL, ENV } from './helpers';

export const STORE_ORIGIN = 'https://lsdev.myshopline.com';
export const USABLE_PROPOSAL = JSON.stringify({ pages: { Home: { boxes: [] } } });
export const DURABLE_OBJECT_ENTRY_LIMIT_BYTES = 2_000_000;

interface NamedDurableObjectId {
  readonly name: string;
}

export const AUTHORITIES_BY_ENV = new WeakMap<Env, Map<string, AuditSessionAuthority>>();
export const AUTHORITY_GATES = new WeakMap<Env, (path: string) => Promise<void>>();

/** Where an injected fault breaks one internal authority call: before it arrives, or after it ran. */
export type AuthorityFault = 'before' | 'after';

/** Per-environment fault injection, chosen by the internal path and the authority's name. */
export const AUTHORITY_FAULTS = new WeakMap<
  Env,
  (path: string, authority: string) => AuthorityFault | undefined
>();
export const STORAGES_BY_ENV = new WeakMap<Env, Map<string, MemoryDurableStorage>>();

/** Per-environment observer of every task an authority hands to its state's `waitUntil`, by authority name. */
export const WAIT_UNTIL_OBSERVERS = new WeakMap<
  Env,
  (authority: string, task: Promise<unknown>) => void
>();

export class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    const entryBytes = serializedEntryBytes(key, value);
    if (entryBytes > DURABLE_OBJECT_ENTRY_LIMIT_BYTES) {
      throw new RangeError(
        `Durable Object entry "${key}" is ${entryBytes} bytes, past the ${DURABLE_OBJECT_ENTRY_LIMIT_BYTES}-byte key and value limit.`,
      );
    }
    this.largestEntryBytes = Math.max(this.largestEntryBytes, entryBytes);
    this.values.set(key, value);
  }

  largestEntryBytes = 0;

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort();
    return new Map(
      keys.slice(0, options.limit ?? keys.length).map((key) => [key, this.values.get(key) as T]),
    );
  }

  keys(): string[] {
    return [...this.values.keys()];
  }

  private alarmAt: number | null = null;

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }

  takeDueAlarm(): boolean {
    if (this.alarmAt === null || this.alarmAt > Date.now()) return false;
    this.alarmAt = null;
    return true;
  }

  async transaction<T>(callback: (storage: MemoryDurableStorage) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = (): void => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

function serializedEntryBytes(key: string, value: unknown): number {
  const encoder = new TextEncoder();
  return encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value ?? null)).byteLength;
}

export function durableEnv(overrides: Partial<Env> = {}): Env {
  const authorities = new Map<string, AuditSessionAuthority>();
  const storages = new Map<string, MemoryDurableStorage>();
  const resolveEnv = (): Env => env;
  const namespace = {
    idFromName(name: string): DurableObjectId {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const name = (id as unknown as NamedDurableObjectId).name;
      let authority = authorities.get(name);
      if (!authority) {
        const storage = new MemoryDurableStorage();
        const waitUntil = (task: Promise<unknown>): void => {
          WAIT_UNTIL_OBSERVERS.get(resolveEnv())?.(name, task);
          task.catch(() => undefined);
        };
        const state = { storage, waitUntil } as unknown as DurableObjectState;
        authority = new AuditSessionAuthority(state, resolveEnv());
        authorities.set(name, authority);
        storages.set(name, storage);
      }
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const path = new URL(request.url).pathname;
          await AUTHORITY_GATES.get(resolveEnv())?.(path);
          const fault = AUTHORITY_FAULTS.get(resolveEnv())?.(path, name);
          if (fault === 'before') throw new TypeError(`Injected fault before ${path} on ${name}`);
          const response = await authority.fetch(request);
          if (fault === 'after') throw new TypeError(`Injected fault after ${path} on ${name}`);
          return response;
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const env: Env = { ...ENV, ...overrides, AUDIT_SESSIONS: namespace };
  AUTHORITIES_BY_ENV.set(env, authorities);
  STORAGES_BY_ENV.set(env, storages);
  return env;
}

export function authorityFor(env: Env, auditIdentifier: string): AuditSessionAuthority {
  const authority = AUTHORITIES_BY_ENV.get(env)?.get(auditIdentifier);
  if (!authority) throw new Error(`Missing test authority for ${auditIdentifier}`);
  return authority;
}

export function storageFor(env: Env, auditIdentifier: string): MemoryDurableStorage {
  const storage = STORAGES_BY_ENV.get(env)?.get(auditIdentifier);
  if (!storage) throw new Error(`Missing test storage for ${auditIdentifier}`);
  return storage;
}

export async function deliverStatusEvents(env: Env): Promise<void> {
  for (const [auditIdentifier, storage] of STORAGES_BY_ENV.get(env) ?? []) {
    while (storage.takeDueAlarm()) await authorityFor(env, auditIdentifier).alarm();
  }
}

export async function activationToken(
  env: Env,
  tokenIdentifier = crypto.randomUUID(),
  entitlement: object = { type: 'store-origin', storeOrigin: STORE_ORIGIN },
  email = 'merchant@example.com',
  auditIdentifier = `audit-${tokenIdentifier}`,
  attemptLimit?: 2 | null,
  statusCallbackUrl: string = AUDIT_STATUS_CALLBACK_URL,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const staff = (entitlement as { type?: unknown }).type === 'limespot-staff-multi-store';
  return signWebsiteActivation(
    {
      version: 1,
      kind: 'activation',
      issuer: 'limespot-website',
      audience: 'app-ai',
      tokenIdentifier,
      auditIdentifier,
      attemptLimit: attemptLimit === undefined ? (staff ? null : 2) : attemptLimit,
      email,
      emailVerified: true,
      entitlement,
      statusCallbackUrl,
      issuedAt: now,
      expiresAt: now + 600,
    },
    env,
  );
}

export async function signWebsiteActivation(claims: object, env: Env): Promise<string> {
  const secret = env.AUDIT_ACTIVATION_SIGNING_SECRET;
  if (!secret) throw new Error('test activation signing secret is missing');
  const encode = (value: object): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  };
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)),
  );
  let signatureBinary = '';
  for (const byte of signature) signatureBinary += String.fromCharCode(byte);
  const encodedSignature = btoa(signatureBinary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `${unsigned}.${encodedSignature}`;
}

export async function exchange(
  env: Env,
  token?: string,
): Promise<{ accessToken: string; sessionIdentifier: string }> {
  const resolvedToken = token ?? (await activationToken(env));
  const response = await worker.fetch(
    new Request('https://app-ai.test/audit/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.limespot.com' },
      body: JSON.stringify({
        activationToken: resolvedToken,
        storeUrl: `${STORE_ORIGIN}/products/example?campaign=grader`,
      }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{ accessToken: string; sessionIdentifier: string }>;
}

export function auditHeaders(
  accessToken: string,
  prompt?: string,
  jsonContent = true,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: STORE_ORIGIN,
    'X-LimeSpot-Audit-Store-Origin': STORE_ORIGIN,
    ...(prompt
      ? {
          ...(jsonContent ? { 'Content-Type': 'application/json' } : {}),
          'X-Personalizer-System-Prompt': prompt,
          'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
        }
      : {}),
  };
}

export function uploadRequest(
  accessToken: string,
  name: string,
  content = name,
  prompts: readonly string[] = [
    'onboarding-batch-all',
    'onboarding-batch',
    'onboarding-review-all',
    'onboarding-review-gate-all',
    'onboarding-currency-recovery',
  ],
): Request {
  const formData = new FormData();
  formData.set('file', new File([content], name, { type: 'image/webp' }));
  for (const prompt of prompts) formData.append('prompt', prompt);
  return new Request('https://app-ai.test/files', {
    method: 'POST',
    headers: auditHeaders(accessToken),
    body: formData,
  });
}

export function messageRequest(
  accessToken: string,
  fileIdentifiers: readonly string[],
  manifest = 'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 1-1, CANDIDATE ANCHORS 1..6',
  prompt = 'onboarding-batch-all',
): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: auditHeaders(accessToken, prompt),
    body: JSON.stringify({
      model: 'caller-chosen-expensive-model',
      tools: [{ name: 'caller_tool' }],
      output_config: { effort: 'xhigh' },
      messages: [
        {
          role: 'user',
          content: [
            ...fileIdentifiers.map((fileIdentifier) => ({
              type: 'image',
              source: { type: 'file', file_id: fileIdentifier },
            })),
            { type: 'text', text: manifest },
          ],
        },
      ],
    }),
  });
}

export async function uploadTiles(env: Env, accessToken: string, count: number): Promise<string[]> {
  const identifiers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await worker.fetch(uploadRequest(accessToken, `tile-${index}.webp`), env);
    expect(response.status).toBe(200);
    identifiers.push(((await response.json()) as { id: string }).id);
  }
  return identifiers;
}
