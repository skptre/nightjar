/** Let input and paint run between bounded chunks of background work. */
export function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Yield during CPU work too; a fixed row count can hide very long postings. */
export function createUIYield(): () => Promise<void> {
  let started = performance.now();
  return async () => {
    if (performance.now() - started < 8) return;
    await yieldToUI();
    started = performance.now();
  };
}
