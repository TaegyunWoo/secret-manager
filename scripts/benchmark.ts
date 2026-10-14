import { pathToFileURL } from 'node:url';

interface BenchmarkOptions {
  url: string;
  token: string;
  mode: 'admin' | 'ci';
  project: string;
  environment: string;
  names: string[];
  iterations: number;
}

export async function measureResolve(options: BenchmarkOptions, send: typeof fetch = fetch) {
  const url = new URL(options.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['admin', 'ci'].includes(options.mode) ||
      !Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 100 ||
      !options.token || /[\r\n]/.test(options.token) || !options.project || !options.environment ||
      !Array.isArray(options.names) || options.names.length < 1 || options.names.length > 100 ||
      options.names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(options.names).size !== options.names.length) {
    throw new Error('Invalid benchmark configuration');
  }
  const endpoint = new URL(options.mode === 'ci' ? '/v1/resolve' : '/api/resolve', url).href;
  const timings: number[] = [];
  let successes = 0;
  for (let i = 0; i < options.iterations; i++) {
    const started = performance.now();
    try {
      const response = await send(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          'content-type': 'application/json',
          ...(options.mode === 'ci' ? { authorization: `Bearer ${options.token}` } : {'cf-access-token': options.token}),
        },
        body: JSON.stringify({project:options.project,environment:options.environment,names:options.names}),
      });
      await response.body?.cancel();
      if (response.ok) successes++;
    } catch {
      // Network errors may contain credentials or response text; retain counts only.
    }
    timings.push(performance.now() - started);
  }
  timings.sort((a,b) => a-b);
  return {
    measurement: 'client-wall-time' as const,
    requests: options.iterations, successes, failures: options.iterations - successes,
    p50Ms: timings[Math.ceil(timings.length * 0.5) - 1]!,
    p95Ms: timings[Math.ceil(timings.length * 0.95) - 1]!,
    maxMs: timings[timings.length - 1]!,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await measureResolve({
      url: process.env.PSM_BENCH_URL ?? '', token: process.env.PSM_BENCH_TOKEN ?? '',
      mode: (process.env.PSM_BENCH_MODE ?? 'admin') as 'admin' | 'ci',
      project: process.env.PSM_BENCH_PROJECT ?? '', environment: process.env.PSM_BENCH_ENVIRONMENT ?? '',
      names: (process.env.PSM_BENCH_NAMES ?? '').split(','), iterations: Number(process.env.PSM_BENCH_ITERATIONS ?? 10),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failures ? 1 : 0;
  } catch {
    console.error('Benchmark configuration is invalid. See docs/operations.md.');
    process.exitCode = 1;
  }
}
