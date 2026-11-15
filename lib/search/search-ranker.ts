import { classifyVideo } from "./search-category";
import { classifyVideosWithML } from "./ml-classifier";
import type { VideoMetadata, VideoClassification } from "./types";

export interface RankedVideo extends VideoMetadata {
  classification: VideoClassification;
}

// Tokenize multilingual text (preserves English, Thai, Korean characters, and numbers)
function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// Compute personalized Naive Bayes boost from localStorage word counts
function computeBayesBoost(
  video: VideoMetadata,
  bayesDict: Record<string, { practice: number; skip: number }>
): number {
  const tokens = tokenize(`${video.title} ${video.tags.join(" ")}`);
  let logOdds = 0;

  for (const token of tokens) {
    const entry = bayesDict[token];
    if (!entry) continue;
    // Laplace smoothing (+1) to prevent zero-division
    const pPractice = (entry.practice + 1) / (entry.practice + entry.skip + 2);
    logOdds += Math.log(pPractice / (1 - pPractice));
  }

  // Sigmoid squashes log-odds into a clean 0.0 to 1.0 personal preference score
  return 1 / (1 + Math.exp(-logOdds));
}

export async function rankSearchResults(
  videos: VideoMetadata[],
  bayesDict: Record<string, { practice: number; skip: number }> = {}
): Promise<RankedVideo[]> {
  const ranked: RankedVideo[] = [];
  const needsML: VideoMetadata[] = [];

  // Stage 1: Fast multilingual regex pass
  for (const video of videos) {
    const regexCat = classifyVideo(video.title, video.tags, video.description);

    if (regexCat === "follow" || regexCat === "tutorial") {
      const bayesScore = computeBayesBoost(video, bayesDict);
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
      if (!ml || !ml.relevant) continue; // Filter out irrelevant/workout videos

      const bayesScore = computeBayesBoost(video, bayesDict);
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

  // Stage 3: Sort highest rank first
  return ranked.sort(
    (a, b) => b.classification.finalRankScore - a.classification.finalRankScore
  );
}
