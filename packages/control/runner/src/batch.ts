import type { TaskResult } from './run.ts'

export interface BatchItem { tenant: string; request: string; template?: string }
export type BatchResult = { item: BatchItem; seconds: number } & ({ result: TaskResult } | { error: Error })

/**
 * Run many tasks side by side. Each task is its own agent process with its own
 * gateway token, so they share nothing. Results come back in input order, and a
 * task that throws is returned as an error instead of stopping the rest.
 */
export async function runBatch(
  runner: { runTask(input: BatchItem): Promise<TaskResult> },
  items: BatchItem[],
  options: { concurrency?: number; onResult?: (result: BatchResult) => void } = {},
): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      const item = items[index]!
      const started = Date.now()
      const outcome = await runner.runTask(item).then(
        result => ({ result }),
        (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      )
      const result: BatchResult = { item, seconds: (Date.now() - started) / 1000, ...outcome }
      results[index] = result
      options.onResult?.(result)
    }
  }
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4))
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
