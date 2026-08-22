/**
 * The app-ai build revision — the EXACT served-worker marker.
 *
 * Injected at build time by esbuild's `--define` (the `npm run dev` script binds
 * `__APP_AI_REV__` to `git rev-parse --short HEAD`; see LOCAL-AI-DEV.md → the FREE stack). When the
 * define is ABSENT — for example, vitest or an unsupported raw `wrangler deploy` — the `typeof`
 * guard short-circuits to `'dev'`. Local/test callers may use that diagnostic marker; production
 * health rejects it with 503. There is never a runtime ReferenceError: `typeof` on an undeclared
 * global is safe, and the `&&`
 * short-circuit never evaluates the bare identifier).
 *
 * `/health` returns this as `buildRev` so the FREE-stack preflight
 * (`onboarding-fork-matrix`'s `preflightMatrixStack`) can assert the served worker is a REAL built
 * revision — fail-closed on `'dev'` / absent — instead of trusting a stale or prod-shaped worker
 * (which would make exact-stack evidence exercise unreviewed worker code). D-12 preferred not adding a build marker;
 * C0014 item 14 supersedes that: the exact-revision proof is stronger with a real served-rev marker.
 * Both supported launchers (`npm run dev` and `npm run deploy`) inject it and fail closed if git
 * cannot resolve the revision.
 */
/* The `__APP_AI_REV__` build-define name follows the conventional dangling-underscore convention for
   esbuild `--define` globals (it is NOT a member access). */
/* eslint-disable no-underscore-dangle */
declare const __APP_AI_REV__: string | undefined;

export const BUILD_REV: string =
  typeof __APP_AI_REV__ === 'string' && __APP_AI_REV__ ? __APP_AI_REV__ : 'dev';
/* eslint-enable no-underscore-dangle */

/** True only for a real short/full hexadecimal git revision emitted by the supported launchers. */
export function isAttributableBuildRevision(buildRev: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(buildRev);
}
