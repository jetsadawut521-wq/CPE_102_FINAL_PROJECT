const STORAGE_KEY = "muverse_bayes_dict";
const USER_WEIGHT = 100;

export type BayesDict = Record<string, { practice: number; skip: number }>;

export function loadBayesDict(): BayesDict {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function recordPracticeFeedback(
  video: { title: string; tags?: string[] },
  isPositive = true
): BayesDict {
  const dict = loadBayesDict();
  const tokens = `${video.title} ${(video.tags ?? []).join(" ")}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  for (const token of tokens) {
    if (!dict[token]) dict[token] = { practice: 1, skip: 1 };
    if (isPositive) {
      dict[token].practice += USER_WEIGHT;
    } else {
      dict[token].skip += USER_WEIGHT;
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(dict));
  return dict;
}
