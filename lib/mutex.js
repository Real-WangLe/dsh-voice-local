
/**
 * dsh-voice-local 共享互斥加载器（评审发现 2 定案）。
 *
 * 把并发调用串行化：后一个任务等前一个 settle 后才开始执行。
 * 用途：懒加载单例的构造保护——避免两个并发 /transcribe 同时加载同一个
 * 本地模型（TODOS.md「后续风险加固」记录过的 ensureRecognizer 竞态，
 * 现由 ensureRecognizer / VAD / denoiser 三处统一收口到本模块）。
 */
export function createMutex() {
  let tail = Promise.resolve();
  return {
    /**
     * 运行 fn()（无论前一个任务成功或失败），返回 fn 的 promise。
     * fn 的失败不会污染后续排队任务。
     * @template T
     * @param {() => Promise<T> | T} fn
     * @returns {Promise<T>}
     */
    run(fn) {
      const run = tail.then(fn, fn);
      tail = run.catch(() => {});
      return run;
    },
  };
}
