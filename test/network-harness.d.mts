export interface StubReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly delayMilliseconds?: number;
  readonly onSettled?: (outcome: 'sent' | 'dropped') => void;
}

export interface StubRequest {
  readonly body: string;
}

export interface StubOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

export function startStubOrigin(
  routes: Readonly<Record<string, StubReply | ((request: StubRequest) => StubReply)>>,
): Promise<StubOrigin>;

export interface IdleCutProxy {
  readonly port: number;
  cuts(): number;
  close(): Promise<void>;
}

export function startIdleCutProxy(options: {
  readonly targetPort: number;
  readonly idleMilliseconds: number;
}): Promise<IdleCutProxy>;

export interface ByteArrival {
  readonly afterMilliseconds: number;
  readonly bytes: number;
}

export interface HttpAnswer {
  readonly status: number;
  readonly headersAfterMilliseconds: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly arrivals: readonly ByteArrival[];
}

export function postJson(options: {
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}): Promise<HttpAnswer>;

export interface FirstBytes {
  readonly status: number;
  readonly firstBytes: string;
}

export function postJsonUntilFirstByte(options: {
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}): Promise<FirstBytes>;

export interface PlainAnswer {
  readonly status: number;
  readonly body: string;
}

export interface WithheldBodyRequest {
  readonly answered: Promise<PlainAnswer>;
  bytesSent(): number;
  finish(): void;
}

export function postWithheldBody(options: {
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly firstChunk: string;
  readonly declaredBytes: number;
}): WithheldBodyRequest;

export interface RunningWorker {
  readonly port: number;
  logs(): readonly string[];
  close(): Promise<void>;
}

export function startWorker(vars: Readonly<Record<string, string>>): Promise<RunningWorker>;
