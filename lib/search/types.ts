export type VideoCategory = "follow" | "tutorial" | "other";

export interface VideoMetadata {
  id: string;
  title: string;
  description: string;
  tags: string[];
}

export interface VideoClassification {
  relevant: boolean;
  category: VideoCategory;
  relevanceScore: number;
  irrelevantScore: number;
  categoryScore: number;
  finalRankScore: number; // Combined score for sorting search results
  source: "regex" | "ml" | "bayes";
}
