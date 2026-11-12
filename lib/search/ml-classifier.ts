
import { pipeline } from "@huggingface/transformers";
import type {
  VideoMetadata,
  VideoClassification,
  VideoCategory,
} from "./types";

// Change this later without modifying the search API.
const MODEL_ID =
  process.env.MUVERSE_ZERO_SHOT_MODEL ||
  "Xenova/mobilebert-uncased-mnli";

// One model instance shared across requests.
let classifierPromise: Promise<any> | null = null;

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = pipeline(
      "zero-shot-classification",
      MODEL_ID
    ).catch((error) => {
      // Allow another attempt if model loading fails.
      classifierPromise = null;
      throw error;
    });
  }

  return classifierPromise;
}

// Each label describes a type of video Muverse accepts.
const LABELS = {
  follow:
    "a dance practice, dance cover, or dance-along video showing choreography people can follow",

  tutorial:
    "a dance tutorial teaching choreography or explaining dance steps",

  other:
    "a dance workout, dance performance, concert or stage performance, or official music video",

  irrelevant:
    "a video unrelated to dancing, choreography, dance performances, concert performances, or official music videos",
} as const;

const CANDIDATE_LABELS = Object.values(LABELS);

const LABEL_TO_CATEGORY: Record<string, VideoCategory> = {
  [LABELS.follow]: "follow",
  [LABELS.tutorial]: "tutorial",
  [LABELS.other]: "other",
};

const RELEVANCE_THRESHOLD = Number(
  process.env.MUVERSE_RELEVANCE_THRESHOLD ?? "0.35"
);

// Prepare metadata for the model.
function buildVideoText(video: VideoMetadata): string {
  return [
    `Title: ${video.title}`,
    `Tags: ${video.tags.slice(0, 20).join(", ")}`,
    `Description: ${video.description.slice(0, 1000)}`,
  ].join("\n");
}

export async function classifyVideosWithML(
  videos: VideoMetadata[]
): Promise<Map<string, VideoClassification>> {
  const results = new Map<string, VideoClassification>();

  if (videos.length === 0) return results;

  const classifier = await getClassifier();

  // Process smaller batches to avoid excessive memory usage.
  const BATCH_SIZE = 8;

  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    const batch = videos.slice(i, i + BATCH_SIZE);

    const texts = batch.map(buildVideoText);

    const predictions = await classifier(
      texts,
      CANDIDATE_LABELS,
      {
        multi_label: true,
        hypothesis_template: "This video is {}.",
      }
    );

    for (let j = 0; j < batch.length; j++) {
      const prediction = predictions[j];

      // Match each label with its corresponding score.
      const scores: Record<string, number> = {};

      prediction.labels.forEach(
        (label: string, index: number) => {
          scores[label] = prediction.scores[index];
        }
      );

      const followScore = scores[LABELS.follow] ?? 0;
      const tutorialScore = scores[LABELS.tutorial] ?? 0;
      const otherScore = scores[LABELS.other] ?? 0;
      const irrelevantScore = scores[LABELS.irrelevant] ?? 0;

      // Find the strongest relevant category.
      const categoryScores = [
        { category: "follow" as const, score: followScore },
        { category: "tutorial" as const, score: tutorialScore },
        { category: "other" as const, score: otherScore },
      ];

      const bestCategory = categoryScores.reduce((best, current) =>
        current.score > best.score ? current : best
      );

      // Relevance is separate from category.
      const relevanceScore = bestCategory.score;

      const relevant =
        relevanceScore >= RELEVANCE_THRESHOLD &&
        relevanceScore > irrelevantScore;

      results.set(batch[j].id, {
        relevant,
        category: bestCategory.category,
        relevanceScore,
        irrelevantScore,
        categoryScore: bestCategory.score,
      });
    }
  }

  return results;
}
