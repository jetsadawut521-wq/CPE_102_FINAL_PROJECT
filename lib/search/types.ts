
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

  // Internal confidence scores from the ML model
  relevanceScore: number;
  irrelevantScore: number;
  categoryScore: number;
}
z
