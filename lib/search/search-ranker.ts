import { classifyVideo } from "./search-category";
import { classifyVideosWithML } from "./ml-classifier";
import type { VideoMetadata, VideoClassification } from "./types";

export interface RankedVideo extends VideoMetadata {
  classification: VideoClassification;
}

// Pre-trained Naive Bayes weights for dance practice vs. non-practice noise
const SEEDED_BAYES_DICT: Record<string, { practice: number; skip: number }> = {
  mirrored: { practice: 500, skip: 10 },
  tutorial: { practice: 450, skip: 15 },
  breakdown: { practice: 400, skip: 15 },
  practice: { practice: 350, skip: 25 },
  choreography: { practice: 300, skip: 40 },
  slowed: { practice: 300, skip: 10 },
  "50": { practice: 200, skip: 20 },
  "75": { practice: 200, skip: 20 },
  สอนเต้น: { practice: 450, skip: 10 },
  ซ้อมเต้น: { practice: 400, skip: 15 },
  เต้นตาม: { practice: 350, skip: 20 },
  안무: { practice: 350, skip: 20 },
  official: { practice: 15, skip: 700 },
  mv: { practice: 10, skip: 800 },
  reaction: { practice: 5, skip: 900 },
  fancam: { practice: 60, skip: 500 },
  concert: { practice: 30, skip: 600 },
};

function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function computeBayesScore(video: VideoMetadata): number {
  const tokens = tokenize(`${video.title} ${video.tags.join(" ")}`);
  let logOdds = 0;

  for (const token of tokens) {
    const entry = SEEDED_BAYES_DICT[token];
    if (!entry) continue;
    const pPractice = (entry.practice + 1) / (entry.practice + entry.skip + 2);
    logOdds += Math.log(pPractice / (1 - pPractice));
  }

  return 1 / (1 + Math.exp(-logOdds));
}

export async function rankSearchResults(
  videos: VideoMetadata[]
): Promise<RankedVideo[]> {
  const ranked: RankedVideo[] = [];
  const needsML: VideoMetadata[] = [];

  // Stage 1: Fast multilingual regex pass
  for (const video of videos) {
    const regexCat = classifyVideo(video.title, video.tags, video.description);

    if (regexCat === "follow" || regexCat === "tutorial") {
      const bayesScore = computeBayesScore(video);
      ranked.push({
        ...video,
        classification: {
          relevant: true,
          category: regexCat,
          relevanceScore: 0.9,
          irrelevantScore: 0.05,
          categoryScore: 0.9,
          finalRankScore: 0.7 * 0.9 + 0.3 * bayesScore,
          source: "regex",
        },
      });
    } else {
      needsML.push(video);
    }
  }

  // Stage 2: Zero-shot ML fallback only for ambiguous "other" videos
  if (needsML.length > 0) {
    const mlResults = await classifyVideosWithML(needsML);

    for (const video of needsML) {
      const ml = mlResults.get(video.id);
      if (!ml || !ml.relevant) continue;

      const bayesScore = computeBayesScore(video);
      ranked.push({
        ...video,
        classification: {
          ...ml,
          finalRankScore: 0.7 * ml.relevanceScore + 0.3 * bayesScore,
          source: "ml",
        },
      });
    }
  }

  // Stage 3: Sort highest score first
  return ranked.sort(
    (a, b) => b.classification.finalRankScore - a.classification.finalRankScore
  );
}
