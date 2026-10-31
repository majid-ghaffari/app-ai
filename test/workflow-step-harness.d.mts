export function runStep(
  script: string,
  stubs: Readonly<Record<string, string>>,
  env?: Readonly<Record<string, string>>,
): { status: number | null; stderr: string; calls: string };
