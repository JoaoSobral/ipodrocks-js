const RELEASES_URL =
  "https://api.github.com/repos/JoaoSobral/ipodrocks-js/releases/latest";

export interface LatestRelease {
  tagName: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
}

export function compareVersions(current: string, latest: string): -1 | 0 | 1 {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff < 0) return -1;
    if (diff > 0) return 1;
  }
  return 0;
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch
): Promise<LatestRelease> {
  const res = await fetchImpl(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as {
    tag_name: string;
    html_url: string;
    name: string;
    published_at: string;
  };
  return {
    tagName: data.tag_name,
    htmlUrl: data.html_url,
    name: data.name,
    publishedAt: data.published_at,
  };
}

export function shouldAutoCheck(
  now: number,
  snoozeUntil: number | undefined
): boolean {
  if (snoozeUntil === undefined) return true;
  return now >= snoozeUntil;
}
