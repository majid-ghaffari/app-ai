/**
 * The Studio chat directives app-ai teaches only to a client whose `/chat` request lists them in
 * `clientActions`, because a client that cannot carry one out would otherwise be asked to tell the
 * owner something happened that never does. Each name is the directive's `action`.
 */
export const CLIENT_ACTIONS = ['requestSupport', 'moveBox'] as const;

export type ClientAction = (typeof CLIENT_ACTIONS)[number];

/** The gated directives one request's client carries out. */
export type ClientActions = ReadonlySet<ClientAction>;

export const NO_CLIENT_ACTIONS: ClientActions = new Set();

/**
 * Read a request's `clientActions`: absent is none, a name app-ai does not gate is ignored, and
 * anything but an array of strings is refused with `null`.
 */
export function readClientActions(raw: unknown): ClientActions | null {
  if (raw === undefined) return NO_CLIENT_ACTIONS;
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === 'string')) return null;
  return new Set(CLIENT_ACTIONS.filter((action) => raw.includes(action)));
}
