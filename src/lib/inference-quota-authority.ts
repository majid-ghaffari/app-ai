import {
  auditSessionAuthority,
  freeVisualVerifyAcceptanceReserve,
  freeVisualVerifyDailyLimit,
  freeVisualVerifyEnabled,
  inferenceQuotaInternalOrigin,
  type Env,
} from '../config';
import { WorkerError } from './responses';

const STORAGE_KEY = 'free-visual-verification';
const AUTHORITY_NAME = 'free-visual-verification';

interface DailyQuotaRecord {
  readonly day: string;
  readonly count: number;
}

export type FreeVisualVerificationQuotaClass = 'diagnostic' | 'acceptance';

export async function reserveFreeVisualVerification(
  env: Env,
  quotaClass: FreeVisualVerificationQuotaClass,
): Promise<void> {
  if (!freeVisualVerifyEnabled(env)) {
    throw new WorkerError('Protected visual verification is disabled.', {
      status: 503,
      exceptionType: 'ServiceUnavailableException',
    });
  }
  const namespace = auditSessionAuthority(env);
  const stub = namespace.get(namespace.idFromName(AUTHORITY_NAME));
  const dailyLimit = freeVisualVerifyDailyLimit(env);
  const acceptanceReserve = freeVisualVerifyAcceptanceReserve(env);
  const limit = quotaClass === 'acceptance' ? dailyLimit : dailyLimit - acceptanceReserve;
  const response = await stub.fetch(
    `${inferenceQuotaInternalOrigin(env)}/reserve-free-visual-verification`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit,
        dailyLimit,
        acceptanceReserve,
        quotaClass,
      }),
    },
  );
  if (response.status === 429) {
    throw new WorkerError('Protected visual verification daily quota has been reached.', {
      status: 429,
      exceptionType: 'QuotaExceededException',
    });
  }
  if (!response.ok) throw new Error(`Inference quota authority returned ${response.status}.`);
}

export async function reserveFreeVisualVerificationSlot(
  storage: DurableObjectStorage,
  policy: {
    readonly dailyLimit: number;
    readonly acceptanceReserve: number;
    readonly quotaClass: FreeVisualVerificationQuotaClass;
  },
): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  return storage.transaction(async (transaction) => {
    const current = await transaction.get<DailyQuotaRecord>(STORAGE_KEY);
    const count = current?.day === day ? current.count : 0;
    const ceiling =
      policy.quotaClass === 'acceptance'
        ? policy.dailyLimit
        : policy.dailyLimit - policy.acceptanceReserve;
    if (count >= ceiling) return false;
    await transaction.put(STORAGE_KEY, { day, count: count + 1 });
    return true;
  });
}
